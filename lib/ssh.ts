/**
 * Minimal promise wrapper around ssh2 for running a single command.
 */

import { Client, type ConnectConfig } from 'ssh2';

import type { OsType, SshAuthType } from './types';

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** Connection timeout in milliseconds. */
  timeoutMs?: number;
}

export interface CommandResult {
  code: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
}

/**
 * The built-in shutdown command for each supported operating system.
 *
 * Windows: the OpenSSH server on Windows runs commands through cmd.exe, where
 * `shutdown` is the built-in Windows utility. `/s` shuts down, `/t 0` skips
 * the delay and `/f` forces applications to close.
 *
 * macOS and Linux: `shutdown -h now` halts the machine. It needs root, so it
 * is run through `sudo -n` (non-interactive — it fails rather than hanging on
 * a password prompt), which requires a NOPASSWD sudoers rule for the account.
 */
export const SHUTDOWN_COMMANDS: Readonly<Record<OsType, string>> = Object.freeze({
  windows: 'shutdown /s /t 0 /f',
  macos: 'sudo -n /sbin/shutdown -h now',
  linux: 'sudo -n /sbin/shutdown -h now',
});

/** Returns the shutdown command to run, honouring a user-supplied override. */
export function getShutdownCommand(osType: OsType, override?: string): string {
  const custom = (override ?? '').trim();
  return custom.length > 0 ? custom : SHUTDOWN_COMMANDS[osType];
}

function buildConnectConfig(config: SshConfig): ConnectConfig {
  const base: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: config.timeoutMs ?? 15000,
    // Homey has no interactive console, so never fall back to prompting.
    tryKeyboard: false,
  };

  if (config.authType === 'certificate') {
    const privateKey = (config.privateKey ?? '').trim();

    if (privateKey.length === 0) {
      throw new Error('SSH authentication is set to Certificate but no private key has been configured.');
    }

    base.privateKey = privateKey;

    const passphrase = config.passphrase ?? '';
    if (passphrase.length > 0) {
      base.passphrase = passphrase;
    }

    return base;
  }

  const password = config.password ?? '';

  if (password.length === 0) {
    throw new Error('SSH authentication is set to Password but no password has been configured.');
  }

  base.password = password;

  return base;
}

function validate(config: SshConfig): void {
  if (!config.host) {
    throw new Error('No IP address has been configured.');
  }

  if (!config.username) {
    throw new Error('No SSH username has been configured.');
  }
}

/**
 * Connects over SSH, runs a single command and returns its result.
 *
 * Resolves as long as the command ran, even when it exited non-zero — the
 * caller decides what a non-zero exit means. Rejects when the connection or
 * authentication fails.
 */
export function runCommand(config: SshConfig, command: string): Promise<CommandResult> {
  validate(config);

  const connectConfig = buildConnectConfig(config);

  return new Promise<CommandResult>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let running = false;
    let stdout = '';
    let stderr = '';

    const done = (err: Error | null, result?: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;

      try {
        client.end();
      } catch {
        // Already disconnected.
      }

      if (err) {
        reject(err);
      } else {
        resolve(result as CommandResult);
      }
    };

    client.once('error', (err: Error) => {
      // A command such as `shutdown` tears the connection down underneath us.
      // Once the command is running, a dropped connection is an expected way
      // for it to end rather than a failure.
      if (running) {
        done(null, {
          code: null, stdout, stderr,
        });
        return;
      }

      done(err);
    });

    client.once('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) {
          done(err);
          return;
        }

        running = true;

        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });

        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });

        stream.once('close', (code: number | null, signal?: string) => {
          done(null, {
            code, signal, stdout, stderr,
          });
        });
      });
    });

    try {
      client.connect(connectConfig);
    } catch (err) {
      done(err as Error);
    }
  });
}

/**
 * Verifies that Homey can log in to the server over SSH.
 *
 * @throws {Error} when connecting or authenticating fails.
 */
export async function testConnection(config: SshConfig): Promise<void> {
  await runCommand(config, 'echo homey-netwake');
}

/**
 * Shuts the server down.
 *
 * The connection is usually torn down by the server while the command runs,
 * which ssh2 surfaces as an error. That is expected and is not treated as a
 * failure once the command itself has been accepted.
 */
export async function shutdown(config: SshConfig, osType: OsType, override?: string): Promise<CommandResult> {
  const command = getShutdownCommand(osType, override);
  const result = await runCommand(config, command);

  if (result.code !== null && result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`The shutdown command "${command}" failed with exit code ${result.code}${detail ? `: ${detail}` : '.'}`);
  }

  return result;
}
