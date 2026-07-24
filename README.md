# mill.cat

A browser controller and Bluetooth Low Energy protocol reference for KingSmith and KS Fit WalkingPad treadmills.

The browser app connects straight to a treadmill through Web Bluetooth. It shows live workout data, controls the belt, changes operating modes, and writes device preferences. The repository also contains a Node.js controller and a protocol reference for developers building other clients.

> [!WARNING]
> This software can start moving exercise equipment. Keep the treadmill's emergency stop within reach, stand clear during connection tests, and start at a low speed. Do not operate the treadmill unattended.

## Features

- Live speed, elapsed time, distance, and step count
- Manual start, stop, and speed control from 0.0 to 6.0 km/h
- Auto, manual, and standby modes
- Max speed, start speed, sensor sensitivity, units, child lock, and auto-start preferences
- Raw transmit and receive logs for protocol debugging
- Buffered parsing for BLE frames split across notifications

## Browser quick start

Web Bluetooth requires a secure context and browser support varies by platform. Use a Chromium-based browser that exposes `navigator.bluetooth`, then serve the repository from `localhost` or HTTPS. See the [Web Bluetooth compatibility notes](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) for current browser support.

From the repository root, start a local server:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000>, then:

1. Turn on the WalkingPad and force-quit the KS Fit app. The treadmill accepts one Bluetooth client at a time.
2. Click **Connect** and choose the treadmill in the browser prompt.
3. Check the target speed before clicking **Start**. The initial target is 2.0 km/h.
4. Use **Stop** before disconnecting.

The page contains its own HTML, CSS, and JavaScript. It has no browser-side dependencies or build step.

## Device compatibility

The included browser and Node.js controllers use KingSmith's proprietary Wilink service:

| Purpose | UUID |
| --- | --- |
| Service | `0xFE00` |
| Notifications from the treadmill | `0xFE01` |
| Commands to the treadmill | `0xFE02` |

This service covers WalkingPad models such as the A1, A1 Pro, C2, R1, and R2, along with other KS Fit devices that advertise `0xFE00`.

Some newer treadmills advertise the standard Fitness Machine Service, FTMS `0x1826`. The protocol reference documents FTMS, but the two included controllers still require Wilink. A device that exposes FTMS without Wilink will appear in the browser chooser but will fail when the app tries to open the Wilink service.

Old firmware may ignore preference commands. Basic status, speed, and mode commands use the older command family and have broader support.

## Node.js controller

[`walkingpad.js`](walkingpad.js) provides a CommonJS driver and an executable demo for Wilink devices.

Install its BLE dependency:

```sh
npm install @stoprocent/noble
```

Run the demo:

```sh
node walkingpad.js
```

> [!CAUTION]
> The demo selects the first Wilink treadmill it discovers, switches it to manual mode, starts the belt at 2.0 km/h, and stops after 30 seconds. Read and edit `main()` before running it around people, pets, or multiple treadmills.

The module exports `WalkingPad`, `CMD`, `MODE`, `frame`, `checksum`, and `parseFrame` for use in another CommonJS program. Pass a Noble peripheral to `new WalkingPad(peripheral)`, call `connect()`, and send commands with `pad.send(...)`.

## Protocol reference

[`PROTOCOL.md`](PROTOCOL.md) documents:

- Wilink framing, checksums, commands, preferences, and status notifications
- Standard FTMS characteristics, control-point opcodes, and treadmill data
- Connection sequencing, write timing, and known firmware behavior
- Swift and Node.js implementation sketches
- Reverse-engineering sources and related projects

Start there if you want to add FTMS support, port the controller, or implement another command.

## Project layout

| File | Purpose |
| --- | --- |
| [`index.html`](index.html) | Static Web Bluetooth controller and user interface |
| [`walkingpad.js`](walkingpad.js) | Minimal Node.js Wilink controller and 30-second demo |
| [`PROTOCOL.md`](PROTOCOL.md) | BLE protocol reference |
| [`LICENSE`](LICENSE) | CC0 1.0 legal text |
| [`UNLICENSE`](UNLICENSE) | Unlicense public-domain dedication |

## Troubleshooting

**The page says Web Bluetooth is unsupported**

Use a browser and platform listed in the Web Bluetooth compatibility table. Open the app from `localhost` or HTTPS instead of a local `file://` URL.

**The treadmill does not appear**

Wake the treadmill, enable Bluetooth on the host, and close the KS Fit app or any other controller. Move the host close to the treadmill and try the device prompt again.

**Connection fails after device selection**

The selected device may not expose Wilink `0xFE00`, or another client may hold the GATT connection. Disconnect other clients and retry. FTMS-only devices need a controller implementation based on the FTMS section in [`PROTOCOL.md`](PROTOCOL.md).

**Commands fail or telemetry stops**

Disconnect in the page, power-cycle the treadmill, reload the page, and reconnect. BLE stacks can retain stale GATT sessions after an interrupted connection.

## License

The project is dedicated to the public domain under [CC0 1.0](LICENSE) and [the Unlicense](UNLICENSE).

KingSmith, KS Fit, and WalkingPad are names of their respective owners. This project is an independent implementation and has no affiliation with or endorsement from KingSmith.
