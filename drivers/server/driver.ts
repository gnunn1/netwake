import Homey from 'homey';
import type PairSession from 'homey/lib/PairSession';

import { testConnection } from '../../lib/ssh';
import { isReachable } from '../../lib/status';
import {
  DEFAULT_SETTINGS, isOsType, isSshAuthType, type ServerSettings,
} from '../../lib/types';
import { isValidMac, normalizeMac } from '../../lib/wol';

/**
 * The subset of the device API the flow cards rely on. The device class is
 * exported through `module.exports`, so it cannot be imported as a type here.
 */
interface ServerDeviceLike extends Homey.Device {
  turnOn(): Promise<void>;
  turnOff(): Promise<void>;
  togglePower(): Promise<void>;
}

/** The configuration collected by the pairing view. */
interface PairConfig {
  name?: string;
  mac_address?: string;
  ip_address?: string;
  broadcast_address?: string;
  wol_port?: number | string;
  poll_interval?: number | string;
  status_port?: number | string;
  status_timeout?: number | string;
  os_type?: string;
  ssh_port?: number | string;
  ssh_username?: string;
  ssh_auth_type?: string;
  ssh_password?: string;
  ssh_private_key?: string;
  ssh_passphrase?: string;
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = class ServerDriver extends Homey.Driver {

  override async onInit(): Promise<void> {
    this.registerFlowCards();
    this.log('NetWake driver initialized');
  }

  private registerFlowCards(): void {
    this.homey.flow
      .getActionCard('turn_server_on')
      .registerRunListener(async (args: { device: ServerDeviceLike }) => {
        await args.device.turnOn();
      });

    this.homey.flow
      .getActionCard('turn_server_off')
      .registerRunListener(async (args: { device: ServerDeviceLike }) => {
        await args.device.turnOff();
      });

    this.homey.flow
      .getActionCard('toggle_server_power')
      .registerRunListener(async (args: { device: ServerDeviceLike }) => {
        await args.device.togglePower();
      });
  }

  /**
   * Turns the raw form values from the pairing view into validated settings.
   *
   * @throws {Error} when a required field is missing or malformed.
   */
  private buildSettings(config: PairConfig): ServerSettings {
    const macAddress = toText(config.mac_address);

    if (!isValidMac(macAddress)) {
      throw new Error(this.homey.__('error.invalid_mac'));
    }

    const ipAddress = toText(config.ip_address);

    if (!ipAddress) {
      throw new Error(this.homey.__('error.no_ip'));
    }

    const username = toText(config.ssh_username);

    if (!username) {
      throw new Error(this.homey.__('error.no_username'));
    }

    const authType = isSshAuthType(config.ssh_auth_type)
      ? config.ssh_auth_type
      : DEFAULT_SETTINGS.ssh_auth_type;

    const password = typeof config.ssh_password === 'string' ? config.ssh_password : '';
    const privateKey = typeof config.ssh_private_key === 'string' ? config.ssh_private_key.trim() : '';

    if (authType === 'password' && password.length === 0) {
      throw new Error(this.homey.__('error.no_password'));
    }

    if (authType === 'certificate' && privateKey.length === 0) {
      throw new Error(this.homey.__('error.no_certificate'));
    }

    return {
      mac_address: normalizeMac(macAddress),
      ip_address: ipAddress,
      broadcast_address: toText(config.broadcast_address) || DEFAULT_SETTINGS.broadcast_address,
      wol_port: toNumber(config.wol_port, DEFAULT_SETTINGS.wol_port),

      poll_interval: Math.max(5, toNumber(config.poll_interval, DEFAULT_SETTINGS.poll_interval)),
      status_port: toNumber(config.status_port, DEFAULT_SETTINGS.status_port),
      status_timeout: Math.max(1, toNumber(config.status_timeout, DEFAULT_SETTINGS.status_timeout)),

      os_type: isOsType(config.os_type) ? config.os_type : DEFAULT_SETTINGS.os_type,
      shutdown_command: '',

      ssh_port: toNumber(config.ssh_port, DEFAULT_SETTINGS.ssh_port),
      ssh_username: username,
      ssh_auth_type: authType,
      ssh_password: authType === 'password' ? password : '',
      ssh_private_key: authType === 'certificate' ? privateKey : '',
      ssh_passphrase: authType === 'certificate' && typeof config.ssh_passphrase === 'string'
        ? config.ssh_passphrase
        : '',
    };
  }

  override async onPair(session: PairSession): Promise<void> {
    // Validates the form and reports whether the server currently answers.
    session.setHandler('test_status', async (config: PairConfig) => {
      const settings = this.buildSettings(config);
      const online = await isReachable(
        settings.ip_address,
        settings.status_port,
        settings.status_timeout * 1000,
      );

      return { online };
    });

    // Validates the form and verifies the SSH credentials.
    session.setHandler('test_ssh', async (config: PairConfig) => {
      const settings = this.buildSettings(config);

      await testConnection({
        host: settings.ip_address,
        port: settings.ssh_port,
        username: settings.ssh_username,
        authType: settings.ssh_auth_type,
        password: settings.ssh_password,
        privateKey: settings.ssh_private_key,
        passphrase: settings.ssh_passphrase,
        timeoutMs: 15000,
      });

      return { ok: true };
    });

    // Validates the form and hands the pairing view a ready-to-add device.
    session.setHandler('build_device', async (config: PairConfig) => {
      const settings = this.buildSettings(config);

      return {
        name: toText(config.name) || settings.ip_address,
        data: {
          id: settings.mac_address,
        },
        settings,
      };
    });
  }

};
