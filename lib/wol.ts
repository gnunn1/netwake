/**
 * Wake-on-LAN magic packet support.
 *
 * A magic packet is a UDP payload of 6 bytes of 0xFF followed by the target's
 * 6-byte MAC address repeated 16 times (102 bytes total). It is normally sent
 * to the broadcast address of the target's subnet, because a sleeping machine
 * has no IP address of its own.
 */

import dgram from 'node:dgram';

const MAC_SEPARATORS = /[\s:-]/g;
const HEX_12 = /^[0-9a-fA-F]{12}$/;

export interface WakeOptions {
  /** Address the packet is sent to. Defaults to the global broadcast address. */
  address?: string;
  /** UDP port. 9 (discard) is conventional, some adapters listen on 7. */
  port?: number;
  /** How many copies of the packet to send. Packets may be dropped, so repeat. */
  count?: number;
  /** Delay between repeated packets, in milliseconds. */
  intervalMs?: number;
}

/**
 * Normalises any common MAC notation to upper case colon-separated form.
 *
 * Accepts `001A2B3C4D5E`, `00:1a:2b:3c:4d:5e`, `00-1A-2B-3C-4D-5E` and
 * variations with whitespace.
 *
 * @throws {Error} when the value is not a valid 48-bit MAC address.
 */
export function normalizeMac(mac: string): string {
  const cleaned = String(mac ?? '').replace(MAC_SEPARATORS, '');

  if (!HEX_12.test(cleaned)) {
    throw new Error(`"${mac}" is not a valid MAC address. Expected 6 hexadecimal octets, for example 00:1A:2B:3C:4D:5E.`);
  }

  return (cleaned.toUpperCase().match(/.{2}/g) as string[]).join(':');
}

/** Returns true when the value is a valid MAC address. */
export function isValidMac(mac: string): boolean {
  try {
    normalizeMac(mac);
    return true;
  } catch {
    return false;
  }
}

/** Builds the 102-byte magic packet for the given MAC address. */
export function createMagicPacket(mac: string): Buffer {
  const bytes = Buffer.from(normalizeMac(mac).replace(/:/g, ''), 'hex');
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);

  for (let i = 0; i < 16; i++) {
    bytes.copy(packet, 6 + i * 6);
  }

  return packet;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Sends a Wake-on-LAN magic packet.
 *
 * The socket is bound and broadcast is enabled before sending, and the socket
 * is always closed again — including when sending fails.
 */
export async function wake(mac: string, options: WakeOptions = {}): Promise<void> {
  const {
    address = '255.255.255.255',
    port = 9,
    count = 3,
    intervalMs = 100,
  } = options;

  const packet = createMagicPacket(mac);
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      socket.once('error', onError);
      socket.bind(() => {
        socket.removeListener('error', onError);
        resolve();
      });
    });

    socket.setBroadcast(true);

    for (let i = 0; i < count; i++) {
      if (i > 0) {
        await delay(intervalMs);
      }

      await new Promise<void>((resolve, reject) => {
        socket.send(packet, 0, packet.length, port, address, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }
  } finally {
    try {
      socket.close();
    } catch {
      // The socket was never bound, or is already closed. Nothing to do.
    }
  }
}
