import Homey from 'homey';

import {
  STATS_SETTINGS_KEY, type ServerStats, type StatsSnapshot,
} from './lib/uptime';

/**
 * How often the statistics snapshot is rebuilt on its own.
 *
 * Devices push a refresh the moment their power state changes, so this is only
 * a safety net that keeps the published totals from drifting far behind.
 */
const REFRESH_INTERVAL_MS = 30 * 1000;

/** The part of the device class the app reads statistics through. */
interface StatsProvider {
  getStats(): ServerStats;
}

module.exports = class NetWakeApp extends Homey.App {

  private refreshInterval: NodeJS.Timeout | null = null;

  override async onInit(): Promise<void> {
    // No snapshot is built here: drivers initialise after the app, so
    // getDriver() would still throw. Each device publishes once it comes up,
    // and this interval keeps the totals fresh from then on.
    this.refreshInterval = this.homey.setInterval(
      () => this.refreshStats(),
      REFRESH_INTERVAL_MS,
    );

    this.log('NetWake has been initialized');
  }

  override async onUninit(): Promise<void> {
    if (this.refreshInterval !== null) {
      this.homey.clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /**
   * Publishes a fresh snapshot for the statistics page.
   *
   * The page reads this through `Homey.get('stats')` and extrapolates the
   * uptime locally, so the snapshot only has to be roughly current.
   */
  refreshStats(): void {
    try {
      const snapshot: StatsSnapshot = {
        generatedAt: Date.now(),
        servers: this.collectStats(),
      };

      this.homey.settings.set(STATS_SETTINGS_KEY, snapshot);
    } catch (err) {
      // Never let a reporting problem take the app down; the next interval
      // tick will try again. This also covers onInit running before the
      // driver is ready.
      this.error('Failed to publish statistics:', err);
    }
  }

  private collectStats(): ServerStats[] {
    const devices = this.homey.drivers
      .getDriver('server')
      .getDevices() as unknown as StatsProvider[];

    return devices
      .filter((device) => typeof device.getStats === 'function')
      .map((device) => device.getStats())
      .sort((a, b) => a.name.localeCompare(b.name));
  }

};
