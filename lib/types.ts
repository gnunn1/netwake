/**
 * Shared types for the NetWake app.
 */

export type OsType = 'windows' | 'macos' | 'linux';

export type SshAuthType = 'password' | 'certificate';

/**
 * The shape of the device settings as defined in
 * `drivers/server/driver.settings.compose.json`.
 */
export interface ServerSettings {
  mac_address: string;
  ip_address: string;
  broadcast_address: string;
  wol_port: number;

  poll_interval: number;
  status_port: number;
  status_timeout: number;

  os_type: OsType;
  shutdown_command: string;

  ssh_port: number;
  ssh_username: string;
  ssh_auth_type: SshAuthType;
  ssh_password: string;
  ssh_private_key: string;
  ssh_passphrase: string;
}

export const DEFAULT_SETTINGS: ServerSettings = {
  mac_address: '',
  ip_address: '',
  broadcast_address: '255.255.255.255',
  wol_port: 9,

  poll_interval: 30,
  status_port: 22,
  status_timeout: 3,

  os_type: 'linux',
  shutdown_command: '',

  ssh_port: 22,
  ssh_username: '',
  ssh_auth_type: 'password',
  ssh_password: '',
  ssh_private_key: '',
  ssh_passphrase: '',
};

export const OS_TYPES: readonly OsType[] = ['windows', 'macos', 'linux'];

export const SSH_AUTH_TYPES: readonly SshAuthType[] = ['password', 'certificate'];

export function isOsType(value: unknown): value is OsType {
  return typeof value === 'string' && (OS_TYPES as readonly string[]).includes(value);
}

export function isSshAuthType(value: unknown): value is SshAuthType {
  return typeof value === 'string' && (SSH_AUTH_TYPES as readonly string[]).includes(value);
}
