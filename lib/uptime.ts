/**
 * Uptime accounting for a monitored server.
 *
 * The device polls the server on an interval and reports what it saw. This
 * module turns that stream of samples into a running total of the time the
 * server has been powered on, in a form that survives an app restart.
 *
 * Everything here is pure, so it can be unit tested without a Homey runtime.
 */

/** The persisted uptime bookkeeping for a single server. */
export interface UptimeState {
  /** Milliseconds the server was observed powered on, counted up to `lastSampleAt`. */
  totalMs: number;
  /** When the current powered-on stretch began, or `null` while the server is off. */
  onSince: number | null;
  /** When the power state was last sampled. */
  lastSampleAt: number;
  /** When uptime tracking began for this device. */
  trackingSince: number;
}

/** A point-in-time view of one server, as rendered by the statistics page. */
export interface ServerStats {
  id: string;
  name: string;
  /** False when Homey has marked the device unavailable (e.g. no IP configured). */
  available: boolean;
  isOn: boolean;
  /** Uptime accumulated up to `lastSampleAt`; the page extrapolates from there. */
  totalMs: number;
  lastSampleAt: number;
  trackingSince: number;
}

/** What the app publishes for the statistics page to read. */
export interface StatsSnapshot {
  /** Homey's clock when the snapshot was built, used to correct for clock skew. */
  generatedAt: number;
  servers: ServerStats[];
}

/** The `homey.settings` key the snapshot is published under. */
export const STATS_SETTINGS_KEY = 'stats';

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function createUptimeState(now: number): UptimeState {
  return {
    totalMs: 0,
    onSince: null,
    lastSampleAt: now,
    trackingSince: now,
  };
}

/**
 * Rebuilds state that was read back from the device store.
 *
 * Anything missing or malformed falls back to a fresh value, so a corrupt store
 * degrades to "tracking starts now" rather than throwing during `onInit`.
 *
 * `lastSampleAt` deliberately resets to `now`: time that passed while the app
 * was not running was never observed, so it must not be credited as uptime.
 */
export function reviveUptimeState(raw: unknown, now: number): UptimeState {
  if (raw === null || typeof raw !== 'object') {
    return createUptimeState(now);
  }

  const stored = raw as Record<string, unknown>;
  const onSince = finiteNumber(stored['onSince'], Number.NaN);

  return {
    totalMs: Math.max(0, finiteNumber(stored['totalMs'], 0)),
    onSince: Number.isFinite(onSince) ? onSince : null,
    lastSampleAt: now,
    trackingSince: finiteNumber(stored['trackingSince'], now),
  };
}

/**
 * Folds one observation into the running total.
 *
 * The interval between two samples counts as uptime when the *earlier* sample
 * saw the server on. A server that switches off between polls therefore has the
 * whole interval credited to it, which over-counts by at most one poll interval
 * per power cycle — negligible next to the default 30 second poll, and far
 * simpler than trying to guess the moment it actually went down.
 */
export function recordSample(state: UptimeState, isOn: boolean, now: number): UptimeState {
  const wasOn = state.onSince !== null;
  const elapsed = Math.max(0, now - state.lastSampleAt);

  return {
    totalMs: state.totalMs + (wasOn ? elapsed : 0),
    onSince: isOn ? (state.onSince ?? now) : null,
    lastSampleAt: now,
    trackingSince: state.trackingSince,
  };
}

/** The total uptime including the stretch since the last sample, when still on. */
export function totalUptimeMs(state: UptimeState, now: number): number {
  const pending = state.onSince !== null ? Math.max(0, now - state.lastSampleAt) : 0;
  return state.totalMs + pending;
}

/**
 * Renders a duration as a short two-unit string, e.g. `3d 4h` or `12m 30s`.
 *
 * The statistics page carries its own copy of this logic so it can tick the
 * value every second without a round trip; keep the two in step.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;

  return `${seconds}s`;
}
