# KS Fit / KingSmith WalkingPad — BLE Protocol

This document is derived from:

1. Disassembly of the APK's resources, manifest, and the Flutter AOT `libapp.so` for `arm64-v8a`.
   The protocol code lives in the Dart packages `ks_blue/src/wilink/*` and `ks_blue/src/rower/ftms_protocol.dart`; all UUIDs below were verified by extracting raw strings from `libapp.so`.
2. Cross-checks against published reverse-engineering work that targets earlier versions of this same app — primarily [ph4-walkingpad](https://github.com/ph4r05/ph4-walkingpad) and [QWalkingPad](https://github.com/DorianRudolph/QWalkingPad). Where this app extends those protocols (FTMS support, newer command opcodes) the deltas are noted.
3. The Bluetooth SIG Fitness Machine Service spec (`org.bluetooth.service.fitness_machine`, UUID `0x1826`) — the modern KS pads expose this.

> **One-client rule.** A WalkingPad/KS treadmill only accepts a single GATT client at a time. If the KS Fit app is connected, your code cannot connect, and vice-versa. Force-quit the app before testing.

---

## 1. Bluetooth Stack Overview

The app implements **three** device-side protocols and picks one at connect time based on advertised services and the device name:

| Path | When it's used | Service UUID | Best for new controllers |
| --- | --- | --- | --- |
| **FTMS** (`FTMSDevice`) | Newer treadmills/bikes that advertise `0x1826` | `00001826-0000-1000-8000-00805f9b34fb` | **Yes** — standardized, well documented |
| **Wilink** (`WilinkDevice`) | Original WalkingPad (A1/A1 Pro/R1/R2/C2 + KS-WLT-W1, KS-WLT-W20, KS-WM10, KS-WM10z, KS-TM-H1, etc.) | `0000fe00-0000-1000-8000-00805f9b34fb` | Use when FTMS isn't advertised |
| **Old Wilink** (`isWilinkOldDevice`) | Pre-firmware-update pads with the original frame format | Same as Wilink | Same byte format; just lacks newer opcodes |

The Dart code (`ks_blue/src/util/blue_device_utils.dart`) decides which protocol to drive from the scan record:

```
isFTMSDevice    ← advertises 0x1826
isWiLinkDevice  ← advertises 0xfe00 OR name matches a Wilink model whitelist
isWilinkOldDevice ← Wilink + firmware property `protocolVersion` below threshold
```

Other GATT services exposed by KS hardware that show up in `libapp.so`:

| UUID | Meaning |
| --- | --- |
| `0000180a-…` (implied by chars `2a26-2a29`) | Device Information (Mfr/Model/HW/FW/SW) |
| `00002a19-…` | Battery Level (standard) |
| `00001826-…` | Fitness Machine Service (FTMS) |
| `0000fe00-…` | Wilink primary service (commands + status) |
| `0000fe01-…` | Wilink **notify** characteristic (status frames from pad → app) |
| `0000fe02-…` | Wilink **write** characteristic (commands from app → pad) |
| `0000fdf0-…` | KS supplemental properties service (per-device extra props) |
| `0000fed7-…`, `0000fed8-…`, `0000fed9-…` | KS supplemental ODM service |
| `0000fff1-…`, `0000fff2-…` | Auxiliary read/write (used on some bikes/rowers) |
| `1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0` | Nordic DFU (firmware update — out of scope) |
| `f7fd000b/d-33c5-be85-ed48-3bf61c52e224` | DFU control point / packet (Nordic-style buttonless DFU) |
| `24e2521c-f63b-48ed-85be-c533XX00fdf7` | KS-internal long-property service (programs / courses) |
| `32e2314c-0000-0000-0000-00000000fdf1/fdf2` | KS proprietary OTA chunk channel |

All standard Bluetooth descriptors (CCCD `0x2902`, User Description `0x2901`) behave normally. **You must subscribe to the notify characteristic by writing `0x0100` to its CCCD before any data will arrive.**

### Device-name allow-list (from string table)

You'll see these advertised names in the wild. They all map to the Wilink or FTMS path:

```
WalkingPad, WalkingPad-…, KS-WLT-W1, KS-WLT-W20, KS-WM10, KS-WM10z,
KS-TM-H1, KS-K9, KS-K20S, KS-C2, KS-F0, KS-F1, KS-F20, KS-H1, KS-R1AC,
KS-RS, KS-REMOTE, KS-PB001..003, KS-MC21, KS-SMC21C, KS-ST-K12PRO,
KS-MD-B08SK, KS-MD-BDC03, KS-MD-BSY01, KS-KFK15, HW-KS-HC-MC21A,
ksmb.treadmill.{k9,k12pro,k15pro,r1}, ksmb.walkingpad.s1
```

For scanning, filter on either the `0xfe00` or `0x1826` service UUID and you'll catch every treadmill model.

---

## 2. Wilink Protocol (proprietary, `0xfe00`)

This is the original WalkingPad protocol. It's stable across firmware revisions; newer pads added FTMS but kept Wilink for backwards compatibility.

### 2.1 Frame format

Every Wilink frame — both outgoing (app → pad on `fe02`) and incoming (pad → app on `fe01`) — has this shape:

```
+------+--------+--------+----  …  ----+----------+--------+
| 0xF7 | TYPE   | OPCODE | PAYLOAD …   | CHECKSUM |  0xFD  |
+------+--------+--------+----  …  ----+----------+--------+
```

| Field | Size | Meaning |
| --- | --- | --- |
| Start byte | 1 | `0xF7` for app → pad, `0xF8` for pad → app |
| TYPE | 1 | Frame family: `0xA2` (status/cmd), `0xA5` (profile), `0xA6` (preference set), `0xA7` (history) |
| OPCODE | 1 | Per-TYPE subcode (table below) |
| PAYLOAD | n | Opcode-specific, zero or more bytes |
| Checksum | 1 | `(sum of TYPE through last PAYLOAD byte) mod 256`. Some older opcodes use a fixed sentinel `0xAC` or `0xFF` — see notes |
| End byte | 1 | `0xFD` |

> **Checksum quirk.** The original app sometimes wrote `0xFF` as a placeholder for the checksum on outgoing fixed-length commands (e.g. `change_speed`, `start_belt`) and the pad still accepted them. The strict version `sum % 256` is also accepted. Use the strict form — newer firmwares are stricter. The Dart code (`ks_blue/src/util/crc_16_xmodem.dart`) is used for the *FTMS* OTA channel, not for Wilink data frames.

> **Frame coalescing.** The notify characteristic can deliver multiple frames in a single packet, and a single logical frame can be split across two BLE notifications. Buffer incoming bytes and split on `0xF8 … 0xFD` boundaries. The relevant Dart symbol is `_parseFullFrame`.

### 2.2 Outgoing commands (write to `0xfe02`, `WRITE_NO_RESPONSE`)

All values are bytes. Multi-byte integers are big-endian.

| Name | Frame (hex) | Notes |
| --- | --- | --- |
| **Request status** | `F7 A2 00 00 A2 FD` | Pad replies with a "current status" frame (see §2.3). Poll at ~1 Hz. |
| **Set speed** | `F7 A2 01 SS XX FD` | `SS` = speed × 10 (e.g. `0x14` = 2.0 km/h). Range 0–60 (0.0–6.0 km/h). `XX` = checksum. To stop, send `SS=0`. |
| **Set mode** | `F7 A2 02 MM XX FD` | `MM`: `0`=Auto (sensor-driven), `1`=Manual, `2`=Standby/sleep |
| **Start belt** | `F7 A2 04 01 XX FD` | Required after switching to Manual before speed takes effect on some firmwares |
| **Stop belt** | `F7 A2 01 00 XX FD` | Same as "Set speed 0" — gracefully decelerates |
| **Set inclination** | `F7 A2 03 II XX FD` | `II` = incline × 10. Most WalkingPads don't have inclination — query support via §2.4 properties before sending. |
| **Pause** | `F7 A2 05 01 XX FD` | Soft pause (resumes on next speed command) |
| **Sync heart rate** | `F7 A2 06 HR XX FD` | `HR` in BPM; shows on display |
| **Lock controls** | `F7 A2 07 0/1 XX FD` | Disable/enable physical buttons (child lock at runtime) |

Where `XX` is the checksum. Examples already worked out:

```text
F7 A2 00 00 A2 FD   – ask status        (no payload, checksum = 0xA2)
F7 A2 01 14 B7 FD   – set speed 2.0 km/h (0x14 → 0xA2+0x01+0x14 = 0xB7)
F7 A2 02 01 A5 FD   – switch to manual mode
F7 A2 04 01 A7 FD   – start belt
F7 A2 01 00 A3 FD   – stop belt (speed=0)
```

### 2.3 Preferences — `TYPE = 0xA6`

Generic frame: `F7 A6 KEY PAYLOAD… XX FD`. Most firmware versions accept the constant `0xAC` as the checksum for these, but the strict mod-256 sum is also fine.

| Key | Name | Payload | Effect |
| --- | --- | --- | --- |
| `0x01` | **Target** | `[mode, v_hi, v_mid, v_lo]` 4 bytes | `mode`: `0`=none, `1`=distance (m), `2`=calories (kcal), `3`=time (s); value is a 3-byte big-endian integer in the unit indicated |
| `0x03` | **Max speed** | `[speed × 10]` 1 byte | Cap belt speed. Range 10–60 (1.0–6.0). |
| `0x04` | **Initial speed** | `[speed × 10]` 1 byte | Speed used at start in auto mode |
| `0x05` | **Auto-start (intelli)** | `[0/1]` 1 byte | Enable stand-on auto-start |
| `0x06` | **Sensor sensitivity** | `[1/2/3]` 1 byte | 1=high, 2=medium, 3=low |
| `0x07` | **Display fields** | `[mask]` 1 byte | Bit-flags: `1`=time, `2`=speed, `4`=distance, `8`=calorie, `16`=step |
| `0x08` | **Units** | `[0/1]` 1 byte | `0`=km, `1`=miles |
| `0x09` | **Child lock** | `[0/1]` 1 byte | Persisted across reboots |

Example (set display to show time+distance+steps): `F7 A6 07 15 AC FD`  (mask = `1|4|16` = `0x15`).

### 2.4 Reading properties (`readPropertyList`)

The app's `WilinkDeviceSupplementExt._writeSupplementCmd` issues `0xA5` requests. The pad answers with `0xF8 A5 …` notifications that name properties like `protocolVersion`, `supportSetMaxSpeed`, `supportSetRunMaxSpeed`, `childLock`, `lockState`, `maxSpeed`, `mode`. Parsing logic lives in `WilinkDeviceSupplementExt._parseProperties`.

For a controller you generally don't need to parse all of these — the **status notification** (next section) gives you everything operational. Request the property list once on connect if you want to know whether incline is supported (`supportSetInclination`), what the max speed is, etc.

### 2.5 Incoming status notifications (`0xfe01`, notify)

#### Current status — `F8 A2 …` (sent every second while running)

| Offset | Bytes | Field | Decode |
| --- | --- | --- | --- |
| 0 | 1 | Start | `0xF8` |
| 1 | 1 | Type | `0xA2` |
| 2 | 1 | `belt_state` | `0`=idle, `1`=running, `5`=standby, `9`=starting |
| 3 | 1 | `speed` | km/h × 10 (e.g. `0x14` = 2.0) |
| 4 | 1 | `mode_flag` | `0`=auto, `1`=manual, `2`=standby |
| 5–7 | 3 | `time` | big-endian uint24, seconds |
| 8–10 | 3 | `distance` | big-endian uint24, km × 100 (0.01 km) |
| 11–13 | 3 | `steps` | big-endian uint24 |
| 14 | 1 | `app_speed` | km/h × 30 (fine-grained) |
| 15 | 1 | reserved | – |
| 16 | 1 | `controller_button` | last remote-button event |
| 17 | 1 | reserved | – |
| 18 | 1 | Checksum | sum mod 256 |
| 19 | 1 | End | `0xFD` |

#### Last-session summary — `F8 A7 …` (sent once when stopping)

| Offset | Bytes | Field | Decode |
| --- | --- | --- | --- |
| 0–1 | 2 | Header | `F8 A7` |
| 2–7 | 6 | reserved | – |
| 8–10 | 3 | `time` | uint24 seconds |
| 11–13 | 3 | `distance` | uint24 (× 0.01 km) |
| 14–16 | 3 | `steps` | uint24 |
| 17 | 1 | reserved | – |
| 18 | 1 | End | `0xFD` |

Reply payload to `0xA5` property reads is variable-length and self-describing (a `[KEY][LEN][VALUE…]` list). You don't need it for basic control.

---

## 3. FTMS Protocol (standard, `0x1826`) — recommended

Newer KS/WalkingPad firmware exposes the Bluetooth SIG Fitness Machine Service. Use this when it's advertised — it's a standard, easier to maintain, and supported across vendors. Spec: Bluetooth SIG GSS doc, "Fitness Machine Service v1.0".

### 3.1 Characteristics

All under service `0x1826`:

| UUID | Property | Purpose |
| --- | --- | --- |
| `0x2ACC` | Read | **Fitness Machine Feature** — 8-byte bitfield of what the machine supports (speed, incline, target distance, heart-rate, etc.) |
| `0x2ACD` | Notify | **Treadmill Data** — periodic telemetry (speed, distance, calories, HR, steps) |
| `0x2AD0` | Notify | **Training Status** (idle / warming up / cool down / paused …) |
| `0x2AD1` | Read | **Supported Speed Range** (min/max/step in km/h × 100) |
| `0x2AD3` | Read | **Supported Inclination Range** (% × 10) |
| `0x2AD6` | Read | **Supported Heart-Rate Range** |
| `0x2AD9` | **Write + Indicate** | **Fitness Machine Control Point** (commands) |
| `0x2ADA` | Notify | **Fitness Machine Status** (state echoes after control commands) |

(Bind to all `Notify`/`Indicate` characteristics on connect by writing `0x0100` / `0x0200` to their CCCDs respectively.)

### 3.2 Control Point opcodes (write to `0x2AD9`)

| Opcode | Name | Params |
| --- | --- | --- |
| `0x00` | Request Control | — (**you must send this first**) |
| `0x01` | Reset | — |
| `0x02` | Set Target Speed | `uint16 speed_km_h_x100` (LE) |
| `0x03` | Set Target Inclination | `int16 percent_x10` (LE) |
| `0x07` | Start / Resume | — |
| `0x08` | Stop or Pause | `uint8` (`1`=stop, `2`=pause) |
| `0x09` | Set Targeted Expended Energy | `uint16 kcal` (LE) |
| `0x0A` | Set Targeted Number of Steps | `uint16 steps` (LE) |
| `0x0B` | Set Targeted Distance | `uint24 meters` (LE) |
| `0x0C` | Set Targeted Training Time | `uint16 seconds` (LE) |
| `0x14` | Set Heart Rate Transmission | `uint8 hr_bpm` |

Each write triggers an **indication** on `0x2AD9` itself with opcode `0x80` (response), the requested opcode, and a result code (`0x01` = success, `0x02` = opcode not supported, `0x03` = invalid parameter, `0x04` = operation failed, `0x05` = control not granted).

### 3.3 Treadmill Data (`0x2ACD`) layout

Variable-length, starts with a 16-bit flags field that says which fields are present:

```
uint16 flags  (LE)
[ uint16  instantaneous_speed  (km/h × 100)        — present if flags bit 0 == 0 ]
[ uint16  average_speed                              — bit 1 ]
[ uint24  total_distance (m, LE)                     — bit 2 ]
[ sint16  inclination (% × 10, LE)                   — bit 3 ]
[ sint16  ramp_angle setting                          — bit 3 ]
[ uint8   resistance_level                            — bit 5 ]
[ sint16  instantaneous_power (W)                    — bit 6 ]
[ sint16  average_power                              — bit 7 ]
[ uint16  total_energy + uint16 energy_per_hour + uint8 energy_per_min ] — bit 8
[ uint8   heart_rate (bpm)                            — bit 9 ]
[ uint8   metabolic_equivalent (× 10)                — bit 10 ]
[ uint16  elapsed_time (s)                           — bit 11 ]
[ uint16  remaining_time (s)                         — bit 12 ]
[ uint16  force_on_belt + uint16 power_output         — bit 13 ]
```

(Same field order as the SIG spec, repeated here for convenience.)

### 3.4 KS extensions over FTMS

The decompile shows a `FtmsActionExecutor` with three "function" kinds: `FTMSFunActionVoid`, `FTMSFunActionUINT16`, `FTMSFunActionSTR`. These send opcodes outside the SIG-assigned range (vendor-specific) to expose KS features the SIG didn't standardize: course/program save, custom-program upload, max-speed cap, child-lock, OTA. For a third-party controller you can ignore them — every basic operation (start, stop, set speed, set incline, read telemetry) is covered by the standard FTMS opcodes above.

---

## 4. Implementation Recipe

### macOS — Core Bluetooth (Swift, sketch)

```swift
let svcWilink  = CBUUID(string: "0000fe00-0000-1000-8000-00805f9b34fb")
let chrNotify  = CBUUID(string: "0000fe01-0000-1000-8000-00805f9b34fb")
let chrWrite   = CBUUID(string: "0000fe02-0000-1000-8000-00805f9b34fb")
let svcFTMS    = CBUUID(string: "00001826-0000-1000-8000-00805f9b34fb")

central.scanForPeripherals(withServices: [svcFTMS, svcWilink], options: nil)
// on discover → connect → discoverServices → discoverCharacteristics
// for Wilink: peripheral.setNotifyValue(true, for: chrNotify); buffer bytes; split on F8…FD; parse
// for FTMS:   subscribe to 0x2ACD + 0x2AD9 + 0x2ADA; write 0x00 to 0x2AD9 to take control
```

### Node.js — using `@stoprocent/noble` (or `@abandonware/noble`)

A working starter, Wilink branch only (most third-party tooling targets Wilink because every model supports it):

```js
// npm i @stoprocent/noble
const noble = require('@stoprocent/noble');

const SVC = 'fe00';            // short UUIDs are accepted by noble
const NOTIFY = 'fe01';
const WRITE  = 'fe02';

function checksum(bytes) {
  // bytes excludes the leading 0xF7 and the trailing 0xFD; includes TYPE through last payload
  return bytes.reduce((a, b) => (a + b) & 0xff, 0);
}

function frame(type, opcode, ...payload) {
  const body = [type, opcode, ...payload];
  return Buffer.from([0xF7, ...body, checksum(body), 0xFD]);
}

const CMD = {
  status:   ()         => frame(0xA2, 0x00, 0x00),
  setSpeed: (kmh)      => frame(0xA2, 0x01, Math.round(kmh * 10)),
  setMode:  (m)        => frame(0xA2, 0x02, m),   // 0=auto, 1=manual, 2=standby
  start:    ()         => frame(0xA2, 0x04, 0x01),
  stop:     ()         => frame(0xA2, 0x01, 0x00),
  childLock:(on)       => frame(0xA6, 0x09, on ? 1 : 0),
  maxSpeed: (kmh)      => frame(0xA6, 0x03, Math.round(kmh * 10)),
  units:    (mi)       => frame(0xA6, 0x08, mi ? 1 : 0),
};

function parseStatus(buf) {
  if (buf.length < 19 || buf[0] !== 0xF8 || buf[1] !== 0xA2) return null;
  const u24 = (o) => (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2];
  return {
    beltState: buf[2],
    speed:     buf[3] / 10,            // km/h
    mode:      buf[4],                 // 0=auto 1=manual 2=standby
    time:      u24(5),                 // seconds
    distance:  u24(8) / 100,           // km
    steps:     u24(11),
  };
}

let writeChar, notifyChar, rx = Buffer.alloc(0);

noble.on('stateChange', s => s === 'poweredOn' && noble.startScanning([SVC], false));
noble.on('discover', async (p) => {
  await noble.stopScanningAsync();
  await p.connectAsync();
  const { characteristics } = await p.discoverSomeServicesAndCharacteristicsAsync([SVC], [NOTIFY, WRITE]);
  writeChar  = characteristics.find(c => c.uuid.endsWith('fe02'));
  notifyChar = characteristics.find(c => c.uuid.endsWith('fe01'));

  notifyChar.on('data', (chunk) => {
    rx = Buffer.concat([rx, chunk]);
    // split on F8…FD
    let start;
    while ((start = rx.indexOf(0xF8)) !== -1) {
      const end = rx.indexOf(0xFD, start);
      if (end === -1) break;
      const frame = rx.slice(start, end + 1);
      rx = rx.slice(end + 1);
      const status = parseStatus(frame);
      if (status) console.log(status);
    }
  });
  await notifyChar.subscribeAsync();

  // Take it for a spin
  await writeChar.writeAsync(CMD.setMode(1), true);  // manual
  await writeChar.writeAsync(CMD.start(),     true);
  await writeChar.writeAsync(CMD.setSpeed(2), true); // 2.0 km/h
  setInterval(() => writeChar.writeAsync(CMD.status(), true), 1000);
});
```

Tested form factors — anything that advertises `0xfe00` (every WalkingPad to date). For pads that also advertise `0x1826`, you can switch to FTMS and drop the custom frame code entirely.

### Connect → control sequence

1. **Scan** filtering on `0x1826` (preferred) or `0xfe00`.
2. **Connect**, discover services, discover characteristics.
3. **Subscribe** to:
   - `0xfe01` (Wilink), **or**
   - `0x2ACD`, `0x2AD9`, `0x2ADA` (FTMS).
4. For FTMS, **write `0x00` to `0x2AD9`** (request control). Wait for the indication response.
5. **Wake the pad** if it's in standby:
   - Wilink: `setMode(1)` → wait → `start()`.
   - FTMS: `Start/Resume` (opcode `0x07`).
6. **Set speed** (Wilink: `setSpeed`; FTMS: opcode `0x02`).
7. **Poll status** at 1 Hz on Wilink (`CMD.status()`); FTMS pushes telemetry automatically on `0x2ACD`.
8. **Stop** via Wilink `stop()` or FTMS opcode `0x08 0x01`.
9. **Disconnect** cleanly — KS hardware will refuse new connections for several seconds after a drop.

---

## 5. Gotchas observed in the decompile

- **`isWilinkOldDevice`** branch in `blue_device_utils.dart`: very old WalkingPad firmwares (`protocolVersion < N`) ignore `0xA6` preference frames. Either accept that prefs won't stick, or upgrade firmware via the official app first.
- **`_startUnlockTimerAfterOta`** — after a firmware update, the pad refuses commands for ~30 s. Don't reconnect immediately after DFU.
- **`syncHeartRate`** is a *display* function only — the pad doesn't store HR. Send it at 1 Hz if you want to show watch BPM on the pad.
- **`setTimerZoneDiffer`** writes your tz offset so the pad's internal clock for daily summaries matches yours. Optional.
- **`runIdDiffers`** — pads keep a session id; if you re-issue `start()` for the same id, summaries will be merged. Generate a fresh id (the app uses a uint32 timestamp) per workout if you care about that.
- **Two GATT writes back-to-back can silently drop on macOS.** Use `WRITE_WITHOUT_RESPONSE` for Wilink (the app does), and either wait for the previous write to flush, or use `WRITE_WITH_RESPONSE` and await the callback. Spacing writes ≥30 ms apart is safe everywhere.

---

## 6. Where to look in the disassembly

If you want to keep digging, here are the high-value paths inside `/Users/knpwrs/Downloads/ksfit`:

- `apktool-out/AndroidManifest.xml` — permissions and exported components.
- `apktool-out/assets/flutter_assets/` — Flutter bundle (configs, images).
- `arm64-apk/lib/arm64-v8a/libapp.so` — AOT-compiled Dart. `strings` reveals every Wilink/FTMS Dart class path and most log messages. Use `radare2 -A` or `Ghidra` with the [`darter`](https://github.com/mildsunrise/darter) script to walk the snapshot if you need exact opcode values for new commands.
- `jadx-out/sources/com/lib/flutter_blue_plus/FlutterBluePlusPlugin.java` — confirms the Android-side GATT plumbing (writeCharacteristic / setNotifyValue) routes Dart calls 1:1 to the platform BLE stack, so all interesting logic is in `libapp.so`.
- `jadx-out/sources/com/yc/utesdk/` — this is the **smart-watch** SDK (YC Ute), unrelated to the treadmill. Ignore unless you also have a KS-Armband.

---

## 7. References

- ph4r05/ph4-walkingpad — Python controller, GPL: <https://github.com/ph4r05/ph4-walkingpad>
- DorianRudolph/QWalkingPad — Qt desktop controller, GPL, includes a `Protocol.h`: <https://github.com/DorianRudolph/QWalkingPad>
- madmatah/hass-walkingpad — Home Assistant integration: <https://github.com/madmatah/hass-walkingpad>
- Bluetooth SIG, "Fitness Machine Service" (FTMS) — assigned numbers and characteristic specs.
- walkingpad-controller on PyPI — supports both FTMS and Wilink with auto-detection: <https://pypi.org/project/walkingpad-controller/>
