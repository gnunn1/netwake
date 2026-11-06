/**
 * Smoke tests for the framework-independent helpers in lib/.
 *
 * Run against the compiled output:  node --test test/
 */

const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const net = require('node:net');
const { describe, it } = require('node:test');

const { createMagicPacket, isValidMac, normalizeMac, wake } = require('../.homeybuild/lib/wol');
const { getShutdownCommand, SHUTDOWN_COMMANDS } = require('../.homeybuild/lib/ssh');
const { isReachable } = require('../.homeybuild/lib/status');
const {
  createUptimeState,
  currentUptimeMs,
  formatDuration,
  recordSample,
  reviveUptimeState,
  totalUptimeMs,
} = require('../.homeybuild/lib/uptime');

describe('normalizeMac', () => {
  it('accepts colon, dash and bare notation', () => {
    assert.equal(normalizeMac('00:1a:2b:3c:4d:5e'), '00:1A:2B:3C:4D:5E');
    assert.equal(normalizeMac('00-1A-2B-3C-4D-5E'), '00:1A:2B:3C:4D:5E');
    assert.equal(normalizeMac('001a2b3c4d5e'), '00:1A:2B:3C:4D:5E');
  });

  it('rejects malformed addresses', () => {
    assert.throws(() => normalizeMac('00:1A:2B:3C:4D'), /not a valid MAC/);
    assert.throws(() => normalizeMac('zz:1A:2B:3C:4D:5E'), /not a valid MAC/);
    assert.throws(() => normalizeMac(''), /not a valid MAC/);
    assert.equal(isValidMac('00:1A:2B:3C:4D:5E'), true);
    assert.equal(isValidMac('nope'), false);
  });
});

describe('createMagicPacket', () => {
  it('builds a 102 byte packet with the correct structure', () => {
    const packet = createMagicPacket('00:1A:2B:3C:4D:5E');
    const mac = Buffer.from('001A2B3C4D5E', 'hex');

    assert.equal(packet.length, 102);
    assert.deepEqual(packet.subarray(0, 6), Buffer.alloc(6, 0xff));

    for (let i = 0; i < 16; i++) {
      assert.deepEqual(packet.subarray(6 + i * 6, 12 + i * 6), mac, `repetition ${i}`);
    }
  });
});

describe('wake', () => {
  it('sends the magic packet over UDP', async () => {
    const socket = dgram.createSocket('udp4');

    const port = await new Promise((resolve) => {
      socket.bind(0, '127.0.0.1', () => resolve(socket.address().port));
    });

    const received = new Promise((resolve) => socket.once('message', resolve));

    await wake('00:1A:2B:3C:4D:5E', { address: '127.0.0.1', port, count: 1 });

    const message = await received;
    socket.close();

    assert.deepEqual(message, createMagicPacket('00:1A:2B:3C:4D:5E'));
  });
});

describe('getShutdownCommand', () => {
  it('returns the built-in command per operating system', () => {
    assert.equal(getShutdownCommand('windows'), 'shutdown /s /t 0 /f');
    assert.equal(getShutdownCommand('macos'), SHUTDOWN_COMMANDS.macos);
    assert.equal(getShutdownCommand('linux'), 'sudo -n /sbin/shutdown -h now');
  });

  it('prefers a non-empty override', () => {
    assert.equal(getShutdownCommand('linux', ' systemctl poweroff '), 'systemctl poweroff');
    assert.equal(getShutdownCommand('linux', '   '), SHUTDOWN_COMMANDS.linux);
    assert.equal(getShutdownCommand('linux', undefined), SHUTDOWN_COMMANDS.linux);
  });
});

describe('isReachable', () => {
  it('is true when the port accepts connections', async () => {
    const server = net.createServer();
    const port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });

    assert.equal(await isReachable('127.0.0.1', port, 2000), true);
    await new Promise((resolve) => server.close(resolve));
  });

  it('is true when the host refuses the connection (host is up)', async () => {
    const server = net.createServer();
    const port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    await new Promise((resolve) => server.close(resolve));

    assert.equal(await isReachable('127.0.0.1', port, 2000), true);
  });

  it('is false when the host does not answer', async () => {
    // 192.0.2.0/24 is reserved for documentation and is never routed.
    assert.equal(await isReachable('192.0.2.1', 22, 1000), false);
  });

  it('is false when no host is configured', async () => {
    assert.equal(await isReachable('', 22, 1000), false);
  });
});

describe('recordSample', () => {
  const T0 = 1_700_000_000_000;

  it('counts nothing while the server stays off', () => {
    let state = createUptimeState(T0);

    state = recordSample(state, false, T0 + 30_000);
    state = recordSample(state, false, T0 + 60_000);

    assert.equal(state.totalMs, 0);
    assert.equal(state.onSince, null);
  });

  it('accumulates the interval between two samples that saw the server on', () => {
    let state = createUptimeState(T0);

    state = recordSample(state, true, T0 + 10_000);
    assert.equal(state.totalMs, 0, 'the stretch before it came on does not count');
    assert.equal(state.onSince, T0 + 10_000);

    state = recordSample(state, true, T0 + 40_000);
    assert.equal(state.totalMs, 30_000);
    assert.equal(state.onSince, T0 + 10_000, 'the session start is preserved');
  });

  it('closes the session and clears onSince when the server goes off', () => {
    let state = createUptimeState(T0);

    state = recordSample(state, true, T0 + 10_000);
    state = recordSample(state, false, T0 + 70_000);

    assert.equal(state.totalMs, 60_000);
    assert.equal(state.onSince, null);
  });

  it('counts each power cycle separately', () => {
    let state = createUptimeState(T0);

    state = recordSample(state, true, T0 + 1_000);
    state = recordSample(state, false, T0 + 11_000);
    state = recordSample(state, true, T0 + 21_000);
    state = recordSample(state, true, T0 + 26_000);

    assert.equal(state.totalMs, 15_000);
    assert.equal(state.currentMs, 5_000, 'only the latest power cycle');
  });

  it('resets the current stretch when the server goes off', () => {
    let state = createUptimeState(T0);

    state = recordSample(state, true, T0 + 10_000);
    state = recordSample(state, true, T0 + 40_000);
    assert.equal(state.currentMs, 30_000);

    state = recordSample(state, false, T0 + 70_000);
    assert.equal(state.currentMs, 0, 'cleared the moment the server is seen off');
    assert.equal(state.totalMs, 60_000, 'the total keeps the stretch');

    state = recordSample(state, false, T0 + 100_000);
    assert.equal(state.currentMs, 0, 'stays at zero while it remains off');
  });

  it('ignores a clock that jumps backwards', () => {
    let state = createUptimeState(T0);

    state = recordSample(state, true, T0 + 10_000);
    state = recordSample(state, true, T0 - 5_000);

    assert.equal(state.totalMs, 0);
  });
});

describe('totalUptimeMs', () => {
  const T0 = 1_700_000_000_000;

  it('extrapolates past the last sample while the server is on', () => {
    let state = createUptimeState(T0);
    state = recordSample(state, true, T0);

    assert.equal(totalUptimeMs(state, T0 + 5_000), 5_000);
  });

  it('stays flat once the server is off', () => {
    let state = createUptimeState(T0);
    state = recordSample(state, true, T0);
    state = recordSample(state, false, T0 + 5_000);

    assert.equal(totalUptimeMs(state, T0 + 60_000), 5_000);
  });
});

describe('currentUptimeMs', () => {
  const T0 = 1_700_000_000_000;

  it('is zero while the server has never been seen on', () => {
    const state = createUptimeState(T0);

    assert.equal(currentUptimeMs(state, T0 + 60_000), 0);
  });

  it('extrapolates past the last sample while the server is on', () => {
    let state = createUptimeState(T0);
    state = recordSample(state, true, T0);

    assert.equal(currentUptimeMs(state, T0 + 5_000), 5_000);
  });

  it('is zero again once the server goes off', () => {
    let state = createUptimeState(T0);
    state = recordSample(state, true, T0);
    state = recordSample(state, false, T0 + 5_000);

    assert.equal(currentUptimeMs(state, T0 + 60_000), 0);
    assert.equal(totalUptimeMs(state, T0 + 60_000), 5_000, 'the total is unaffected');
  });

  it('restarts from the latest power on, while the total keeps running', () => {
    let state = createUptimeState(T0);

    state = recordSample(state, true, T0);
    state = recordSample(state, true, T0 + 20_000);
    state = recordSample(state, false, T0 + 30_000);
    state = recordSample(state, true, T0 + 40_000);

    assert.equal(currentUptimeMs(state, T0 + 50_000), 10_000);
    assert.equal(totalUptimeMs(state, T0 + 50_000), 40_000);
  });
});

describe('reviveUptimeState', () => {
  const T0 = 1_700_000_000_000;

  it('starts fresh when there is nothing stored', () => {
    const state = reviveUptimeState(undefined, T0);

    assert.equal(state.totalMs, 0);
    assert.equal(state.onSince, null);
    assert.equal(state.trackingSince, T0);
  });

  it('does not credit time while the app was not running', () => {
    const stored = {
      totalMs: 1_000,
      currentMs: 800,
      onSince: T0 - 500_000,
      lastSampleAt: T0 - 500_000,
      trackingSince: T0 - 900_000,
    };
    const state = reviveUptimeState(stored, T0);

    assert.equal(state.lastSampleAt, T0, 'resumes sampling from now');
    assert.equal(totalUptimeMs(state, T0), 1_000);
    assert.equal(currentUptimeMs(state, T0), 800, 'the in-progress stretch continues');
    assert.equal(state.trackingSince, T0 - 900_000, 'tracking start is preserved');
  });

  it('keeps the current stretch at zero when the server was off', () => {
    const stored = {
      totalMs: 1_000, currentMs: 800, onSince: null, trackingSince: T0 - 900_000,
    };
    const state = reviveUptimeState(stored, T0);

    assert.equal(state.currentMs, 0);
    assert.equal(currentUptimeMs(state, T0 + 60_000), 0);
  });

  it('restarts the current stretch for a store written before it was tracked', () => {
    const stored = { totalMs: 1_000, onSince: T0 - 500_000, trackingSince: T0 - 900_000 };
    const state = reviveUptimeState(stored, T0);

    assert.equal(state.currentMs, 0);
    assert.equal(state.totalMs, 1_000, 'the total survives the upgrade');
  });

  it('falls back to sane values for a corrupt store', () => {
    const state = reviveUptimeState({
      totalMs: 'nope', currentMs: 'nope', onSince: {}, trackingSince: null,
    }, T0);

    assert.equal(state.totalMs, 0);
    assert.equal(state.currentMs, 0);
    assert.equal(state.onSince, null);
    assert.equal(state.trackingSince, T0);
  });
});

describe('formatDuration', () => {
  it('renders two units, largest first', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(90_000), '1m 30s');
    assert.equal(formatDuration(3_600_000), '1h 0m');
    assert.equal(formatDuration(3_900_000), '1h 5m');
    assert.equal(formatDuration(86_400_000), '1d 0h');
    assert.equal(formatDuration(275_400_000), '3d 4h');
  });

  it('clamps a negative duration to zero', () => {
    assert.equal(formatDuration(-5_000), '0s');
  });
});
