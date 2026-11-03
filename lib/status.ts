/**
 * Power state detection.
 *
 * Homey apps run sandboxed and cannot open the raw sockets that an ICMP ping
 * needs, so reachability is determined by opening a TCP connection to a port
 * on the server instead. The SSH port is used by default: it has to be open
 * anyway for the shutdown command to work, and it only answers once the
 * operating system has finished booting, which makes it a good proxy for
 * "the server is up".
 */

import net from 'node:net';

/**
 * Attempts a TCP connection and resolves to true when it is established.
 *
 * Never rejects: any failure (refused, unreachable, timeout, DNS error) means
 * the server is not considered reachable.
 */
export function isReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host) {
      resolve(false);
      return;
    }

    const socket = new net.Socket();
    let settled = false;

    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      // A refused connection means something actively sent back a RST, so the
      // host is powered on even though this particular port is closed. That
      // happens while the machine is still booting and SSH has not started.
      finish(err.code === 'ECONNREFUSED');
    });

    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}
