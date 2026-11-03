# NetWake

A Homey app (SDK v3, TypeScript) that turns a server on with a Wake-on-LAN magic packet, turns it off with the operating system's shutdown command over SSH, and keeps Homey's view of its power state up to date.

## Features

- **Wake** a server by broadcasting a Wake-on-LAN magic packet to a configured MAC address.
- **Shut down** a server by running the built-in shutdown command for Windows, macOS or Linux over SSH.
- **Monitor** the power state on a configurable interval, in seconds.
- **SSH authentication** with either a password or a private key (certificate).
- **Power toggle quick action** on the device tile.
- **Flow actions**: *Turn server on*, *Turn server off* and *Toggle power state*.

## Requirements

On the server:

- Wake-on-LAN enabled in the firmware/BIOS **and** in the operating system's network adapter settings. Many adapters only honour magic packets from S5 (soft off) when "Wake on Magic Packet" and "allow this device to wake the computer" are both enabled.
- An SSH server that Homey can reach.
- A static IP address, or a DHCP reservation. The app addresses the server by IP for both status checks and SSH.
- An account allowed to run the shutdown command:
  - **Windows** — the account must have the *Shut down the system* privilege. Administrators do by default.
  - **macOS / Linux** — the built-in command is `sudo -n /sbin/shutdown -h now`. `-n` means it never waits at a password prompt, so the account needs a `NOPASSWD` sudoers rule, for example:
    ```
    homey ALL=(ALL) NOPASSWD: /sbin/shutdown
    ```
    Alternatively set a **Custom shutdown command** in the device settings, e.g. `systemctl poweroff` where polkit already permits it.

On Homey: the app is `local` only — Homey Cloud cannot reach devices on your LAN.

## Installing

```bash
npm install
npm run build          # compiles TypeScript into .homeybuild/
npx homey app validate --level=publish
npx homey app run      # run on a Homey on the same network
npx homey app install  # install permanently
```

`homey app run` and `homey app install` compile the TypeScript themselves — they detect `typescript` in the dependencies and run `npm run build` first.

## Adding a server

The pairing wizard asks for everything in one screen. The SSH credential field changes with the authentication type: **Password** shows a single masked field, **Certificate** shows a multi-line field for the private key plus an optional passphrase.

**Test connection** checks that the server answers on the status port and, if it does, that the SSH credentials work. It is expected to fail while the server is off — you can still add the server and test afterwards.

## Device settings

| Setting | Default | Notes |
| --- | --- | --- |
| MAC address | — | The adapter Wake-on-LAN is enabled on. Accepts `00:1A:2B:3C:4D:5E`, `00-1A-...` or `001A2B3C4D5E`. |
| IP address | — | Used for both status checks and SSH. |
| Broadcast address | `255.255.255.255` | Use the subnet broadcast (e.g. `192.168.1.255`) if your router drops the global broadcast. |
| Wake-on-LAN port | `9` | Some adapters use `7`. |
| Polling interval | `30` s | How often the power state is checked. |
| Status check port | `22` | See *How the power state is detected* below. |
| Status check timeout | `3` s | How long to wait before deciding the server is off. |
| Operating system | `Linux` | Selects the built-in shutdown command. |
| Custom shutdown command | empty | Overrides the built-in command when set. |
| SSH port | `22` | |
| Username | — | |
| Authentication | `Password` | `Password` or `Certificate`. |
| Password | — | Used only when authentication is `Password`. |
| Certificate (private key) | — | Used only when authentication is `Certificate`. Paste the whole key including the BEGIN/END lines. |
| Certificate passphrase | — | Only if the key is encrypted. |

Homey's device settings pages are rendered from a static JSON schema and have no support for showing or hiding fields based on another field's value, so all SSH fields are listed there and the hints state which one applies. The conditional password-vs-certificate behaviour described in the proposal is implemented in the pairing wizard, which is a custom HTML view.

## How the power state is detected

Homey apps are sandboxed and cannot open the raw sockets an ICMP ping needs, so the app opens a **TCP connection to the status check port** instead. The server counts as on when the connection is accepted, or when it is actively refused — a refusal means the host sent back a RST, so it is powered on even if that port is closed (which is what you see while it is still booting). A timeout or an unreachable host counts as off.

The status check port defaults to `22` because SSH has to be reachable anyway for shutdown to work, and it only answers once the OS has finished booting.

After a wake or a shutdown the app polls every 5 seconds for up to 5 minutes and holds the tile at the requested state until the server gets there, so the tile does not flip back and forth during a boot. If the server never reaches that state within the window, the app reports what it actually sees.

## Project layout

```
app.ts                                   app entry point
lib/wol.ts                               magic packet construction and sending
lib/ssh.ts                               ssh2 wrapper and per-OS shutdown commands
lib/status.ts                            TCP reachability check
lib/types.ts                             settings types and defaults
drivers/server/driver.ts                 pairing handlers and flow card listeners
drivers/server/device.ts                 capability listener, actions, polling
drivers/server/pair/configure.html       custom pairing view
drivers/server/driver.compose.json       driver manifest
drivers/server/driver.settings.compose.json  device settings schema
.homeycompose/                           app manifest and flow card definitions
app.json                                 generated by Homey Compose — do not edit by hand
test/lib.test.js                         tests for the helpers in lib/
```

## Tests

```bash
npm test
```

Covers MAC parsing, magic packet structure, actually sending a packet over UDP, shutdown command selection and the TCP reachability check. The Homey-dependent classes are not covered.

## Notes

- `ssh2` lists `cpu-features` as an optional native dependency. If it fails to build, npm carries on and `ssh2` uses its pure-JavaScript implementations; nothing needs to be done.
- SSH passwords and private keys are stored in Homey's device settings.

## License

[MIT](LICENSE)

