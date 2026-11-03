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
