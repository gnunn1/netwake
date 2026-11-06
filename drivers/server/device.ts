import Homey from 'homey';

import { isReachable } from '../../lib/status';
import {
  type SshConfig, shutdown, testConnection,
} from '../../lib/ssh';
import { DEFAULT_SETTINGS, type ServerSettings } from '../../lib/types';
import {
  createUptimeState, currentUptimeMs, recordSample, reviveUptimeState, totalUptimeMs,
  type ServerStats, type UptimeState,
} from '../../lib/uptime';
import { isValidMac, wake } from '../../lib/wol';

/** The device store key the uptime bookkeeping is persisted under. */
const UPTIME_STORE_KEY = 'uptime';

/**
 * How often the running total is written to the device store while the power
 * state is unchanged. Every state change is persisted immediately regardless,
 * so this only bounds how much uptime a sudden restart can lose.
 */
const UPTIME_PERSIST_MS = 60 * 1000;

/** The part of the app class this device calls back into. */
interface StatsPublisher {
  refreshStats(): void;
}

/**
 * Read-only capabilities that surface the statistics on the device's own
 * measurements tab. Devices paired before these existed are migrated in
 * `onInit`, since Homey does not add new capabilities retroactively.
 */
const STATS_CAPABILITIES = ['server_power', 'server_current_uptime', 'server_uptime'] as const;

/**
 * How long after a wake or shutdown the device polls at an increased rate, so
 * the tile follows the server through booting or halting instead of waiting
 * for the next scheduled poll.
 */
const TRANSITION_WINDOW_MS = 5 * 60 * 1000;
const TRANSITION_POLL_MS = 5 * 1000;

module.exports = class ServerDevice extends Homey.Device {

  private pollTimeout: ReturnType<typeof setTimeout> | null = null;

  private pollInFlight = false;

  /** Timestamp until which the faster transition polling applies. */
  private transitionUntil = 0;

  /** The state we are driving towards during a transition, if any. */
  private expectedState: boolean | null = null;

  /** Running uptime bookkeeping, restored from the device store on init. */
  private uptime: UptimeState = createUptimeState(Date.now());

  /** When the uptime state was last written to the device store. */
  private uptimePersistedAt = 0;

  override async onInit(): Promise<void> {
    const now = Date.now();
    this.uptime = reviveUptimeState(this.getStoreValue(UPTIME_STORE_KEY), now);
    this.uptimePersistedAt = now;

    await this.migrateCapabilities();
    await this.updateStatsCapabilities();

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      if (value) {
        await this.turnOn();
      } else {
        await this.turnOff();
      }
    });

    this.schedulePoll(0);

    // Publish straight away so the statistics page has this device as soon as
    // it comes up, rather than waiting for the app's refresh interval.
    this.publishStats();

    this.log(`${this.getName()} initialized`);
  }

  override async onAdded(): Promise<void> {
    this.log(`${this.getName()} added`);
  }

  override async onSettings({ changedKeys }: {
    oldSettings: Record<string, unknown>;
    newSettings: Record<string, unknown>;
    changedKeys: string[];
  }): Promise<void> {
    this.log(`Settings changed: ${changedKeys.join(', ')}`);

    // Homey persists the new settings after this handler resolves, so restart
    // polling on the next tick to make sure the new values are picked up.
    this.schedulePoll(100);
  }

  override async onRenamed(name: string): Promise<void> {
    this.log(`Renamed to ${name}`);
  }

  override async onDeleted(): Promise<void> {
    this.clearPoll();
    this.log('Device deleted');
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private get settings(): ServerSettings {
    return { ...DEFAULT_SETTINGS, ...(this.getSettings() as Partial<ServerSettings>) };
  }

  private getSshConfig(): SshConfig {
    const settings = this.settings;

    return {
      host: settings.ip_address,
      port: settings.ssh_port,
      username: settings.ssh_username,
      authType: settings.ssh_auth_type,
      password: settings.ssh_password,
      privateKey: settings.ssh_private_key,
      passphrase: settings.ssh_passphrase,
      timeoutMs: 15000,
    };
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** Wakes the server by broadcasting a Wake-on-LAN magic packet. */
  async turnOn(): Promise<void> {
    const settings = this.settings;

    if (!isValidMac(settings.mac_address)) {
      throw new Error(this.homey.__('error.invalid_mac'));
    }

    this.log(`Sending magic packet to ${settings.mac_address} via ${settings.broadcast_address}:${settings.wol_port}`);

    await wake(settings.mac_address, {
      address: settings.broadcast_address || '255.255.255.255',
      port: settings.wol_port,
    });

    await this.setCapabilityValue('onoff', true).catch((err) => this.error(err));
    this.beginTransition(true);
  }

  /** Shuts the server down by running the OS shutdown command over SSH. */
  async turnOff(): Promise<void> {
    const settings = this.settings;

    this.log(`Shutting down ${settings.ip_address} over SSH as ${settings.ssh_username}`);

    await shutdown(this.getSshConfig(), settings.os_type, settings.shutdown_command);

    await this.setCapabilityValue('onoff', false).catch((err) => this.error(err));
    this.beginTransition(false);
  }

  /**
   * Turns the server on when it is off and off when it is on.
   *
   * The current state is re-read from the network first, so a toggle never
   * acts on a stale tile value.
   */
  async togglePower(): Promise<void> {
    const isOn = await this.readPowerState();

    if (isOn) {
      await this.turnOff();
    } else {
      await this.turnOn();
    }
  }

  /** Verifies the configured SSH credentials against the server. */
  async testSsh(): Promise<void> {
    await testConnection(this.getSshConfig());
  }

  // ---------------------------------------------------------------------------
  // Uptime statistics
  // ---------------------------------------------------------------------------

  /**
   * Folds one power-state observation into the running uptime total.
   *
   * The total is kept in memory and flushed to the device store on every state
   * change, and otherwise at most once per `UPTIME_PERSIST_MS`, so a 5 second
   * poll interval does not turn into a write every 5 seconds.
   */
  private async recordUptimeSample(isOn: boolean): Promise<void> {
    const now = Date.now();
    const wasOn = this.uptime.onSince !== null;

    this.uptime = recordSample(this.uptime, isOn, now);

    await this.updateStatsCapabilities();

    const stateChanged = wasOn !== isOn;

    if (stateChanged || now - this.uptimePersistedAt >= UPTIME_PERSIST_MS) {
      this.uptimePersistedAt = now;
      await this.setStoreValue(UPTIME_STORE_KEY, this.uptime)
        .catch((err) => this.error('Failed to persist uptime:', err));
    }

    if (stateChanged) {
      this.publishStats();
    }
  }

  /** Adds the statistics capabilities to devices paired before they existed. */
  private async migrateCapabilities(): Promise<void> {
    for (const capability of STATS_CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability)
          .catch((err) => this.error(`Failed to add \`${capability}\`:`, err));
      }
    }
  }

  /**
   * Mirrors the running totals onto the device's read-only capabilities, which
   * is what puts them on the measurements tab and into Insights.
   */
  private async updateStatsCapabilities(): Promise<void> {
    const now = Date.now();
    const isOn = this.uptime.onSince !== null;

    // Rounded to the capabilities' own precision so Insights does not record a
    // change on every poll when nothing meaningful moved.
    const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

    if (this.hasCapability('server_power')) {
      await this.setCapabilityValue('server_power', isOn ? 'on' : 'off')
        .catch((err) => this.error(err));
    }

    if (this.hasCapability('server_current_uptime')) {
      await this.setCapabilityValue('server_current_uptime', hours(currentUptimeMs(this.uptime, now)))
        .catch((err) => this.error(err));
    }

    if (this.hasCapability('server_uptime')) {
      await this.setCapabilityValue('server_uptime', hours(totalUptimeMs(this.uptime, now)))
        .catch((err) => this.error(err));
    }
  }

  /** Asks the app to rebuild the snapshot the statistics page reads. */
  private publishStats(): void {
    const app = this.homey.app as unknown as Partial<StatsPublisher> | undefined;

    if (typeof app?.refreshStats === 'function') {
      app.refreshStats();
    }
  }

  /** The current statistics for this device, for the app to aggregate. */
  getStats(): ServerStats {
    return {
      id: this.getData().id ?? this.getName(),
      name: this.getName(),
      available: this.getAvailable(),
      isOn: this.uptime.onSince !== null,
      totalMs: this.uptime.totalMs,
      currentMs: this.uptime.currentMs,
      lastSampleAt: this.uptime.lastSampleAt,
      trackingSince: this.uptime.trackingSince,
    };
  }

  // ---------------------------------------------------------------------------
  // Power state monitoring
  // ---------------------------------------------------------------------------

  /** Checks whether the server currently answers on the status port. */
  private async readPowerState(): Promise<boolean> {
    const settings = this.settings;

    return isReachable(
      settings.ip_address,
      settings.status_port,
      Math.max(1, settings.status_timeout) * 1000,
    );
  }

  /**
   * Starts a window of faster polling while the server boots or halts.
   *
   * @param expected the state the server is moving towards.
   */
  private beginTransition(expected: boolean): void {
    this.expectedState = expected;
    this.transitionUntil = Date.now() + TRANSITION_WINDOW_MS;
    this.schedulePoll(TRANSITION_POLL_MS);
  }

  private clearPoll(): void {
    if (this.pollTimeout !== null) {
      this.homey.clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  /** Cancels any pending poll and schedules the next one. */
  private schedulePoll(delayMs: number): void {
    this.clearPoll();

    this.pollTimeout = this.homey.setTimeout(() => {
      this.pollTimeout = null;
      this.poll().catch((err) => this.error('Poll failed:', err));
    }, Math.max(0, delayMs));
  }

  private nextPollDelay(): number {
    const settings = this.settings;
    const interval = Math.max(5, settings.poll_interval) * 1000;

    if (Date.now() < this.transitionUntil) {
      return Math.min(TRANSITION_POLL_MS, interval);
    }

    return interval;
  }

  /** Reads the power state, updates the capability, and reschedules itself. */
  private async poll(): Promise<void> {
    if (this.pollInFlight) {
      this.schedulePoll(this.nextPollDelay());
      return;
    }

    this.pollInFlight = true;

    try {
      const settings = this.settings;

      if (!settings.ip_address) {
        // Close any open uptime session rather than leaving the clock running:
        // without an address the server cannot be observed, and resuming later
        // would otherwise credit the whole unobserved gap as uptime.
        await this.recordUptimeSample(false);
        await this.setUnavailable(this.homey.__('error.no_ip')).catch((err) => this.error(err));
        return;
      }

      const isOn = await this.readPowerState();

      // Uptime follows what the network actually reported, not the value shown
      // on the tile, which is held at the expected state during a transition.
      await this.recordUptimeSample(isOn);

      if (!this.getAvailable()) {
        await this.setAvailable().catch((err) => this.error(err));
      }

      if (this.expectedState !== null) {
        if (isOn === this.expectedState) {
          // The server reached the state we asked for.
          this.expectedState = null;
          this.transitionUntil = 0;
        } else if (Date.now() < this.transitionUntil) {
          // Still booting or halting. Keep showing the state we are moving
          // towards rather than flipping the tile back and forth.
          return;
        } else {
          // The server never got there, so fall through and report reality.
          this.log(`Server did not reach the ${this.expectedState ? 'on' : 'off'} state in time`);
          this.expectedState = null;
          this.transitionUntil = 0;
        }
      }

      if (this.getCapabilityValue('onoff') !== isOn) {
        await this.setCapabilityValue('onoff', isOn).catch((err) => this.error(err));
      }
    } finally {
      this.pollInFlight = false;
      this.schedulePoll(this.nextPollDelay());
    }
  }

};
