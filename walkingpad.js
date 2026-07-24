// Minimal Node.js controller for KS Fit / WalkingPad treadmills.
// Implements the Wilink protocol (service 0xFE00) — works on every model the KS Fit app supports.
//
// Install:  npm i @stoprocent/noble
// Run:      node walkingpad.js
//
// See PROTOCOL.md for the full protocol reference.

const noble = require('@stoprocent/noble');

const SVC_WILINK   = 'fe00';
const CHR_NOTIFY   = 'fe01';
const CHR_WRITE    = 'fe02';

const START = 0xF7;
const END   = 0xFD;
const T_CMD = 0xA2;
const T_PREF = 0xA6;

const MODE = { AUTO: 0, MANUAL: 1, STANDBY: 2 };

const checksum = (bytes) => bytes.reduce((a, b) => (a + b) & 0xff, 0);

const frame = (type, opcode, ...payload) => {
  const body = [type, opcode, ...payload];
  return Buffer.from([START, ...body, checksum(body), END]);
};

const CMD = {
  status:    ()    => frame(T_CMD, 0x00, 0x00),
  setSpeed:  (kmh) => frame(T_CMD, 0x01, Math.max(0, Math.min(60, Math.round(kmh * 10)))),
  setMode:   (m)   => frame(T_CMD, 0x02, m),
  setIncline:(pct) => frame(T_CMD, 0x03, Math.max(0, Math.min(180, Math.round(pct * 10)))),
  start:     ()    => frame(T_CMD, 0x04, 0x01),
  stop:      ()    => frame(T_CMD, 0x01, 0x00),
  pause:     ()    => frame(T_CMD, 0x05, 0x01),
  syncHr:    (bpm) => frame(T_CMD, 0x06, bpm & 0xff),
  childLock: (on)  => frame(T_PREF, 0x09, on ? 1 : 0),
  maxSpeed:  (kmh) => frame(T_PREF, 0x03, Math.round(kmh * 10)),
  startSpeed:(kmh) => frame(T_PREF, 0x04, Math.round(kmh * 10)),
  units:     (mi)  => frame(T_PREF, 0x08, mi ? 1 : 0),
  sensitivity:(s)  => frame(T_PREF, 0x06, s),                    // 1=high, 2=med, 3=low
  display:   (mask)=> frame(T_PREF, 0x07, mask & 0x1f),          // 1=time 2=spd 4=dist 8=cal 16=step
  autoStart: (on)  => frame(T_PREF, 0x05, on ? 1 : 0),
};

const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];

function parseFrame(buf) {
  if (buf.length < 6 || buf[0] !== 0xF8 || buf[buf.length - 1] !== 0xFD) return null;
  const type = buf[1];
  if (type === 0xA2 && buf.length >= 19) {
    return {
      kind: 'status',
      beltState: buf[2],
      speed:     buf[3] / 10,
      mode:      buf[4],
      time:      u24(buf, 5),
      distance:  u24(buf, 8) / 100,
      steps:     u24(buf, 11),
      appSpeed:  buf[14] / 30,
      button:    buf[16],
    };
  }
  if (type === 0xA7) {
    return {
      kind: 'lastSession',
      time:     u24(buf, 8),
      distance: u24(buf, 11) / 100,
      steps:    u24(buf, 14),
    };
  }
  return { kind: 'other', type, raw: buf };
}

class WalkingPad {
  constructor(peripheral) {
    this.p = peripheral;
    this.rx = Buffer.alloc(0);
    this.write = null;
    this.notify = null;
    this.listeners = new Set();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async connect() {
    await this.p.connectAsync();
    const { characteristics } = await this.p.discoverSomeServicesAndCharacteristicsAsync(
      [SVC_WILINK], [CHR_NOTIFY, CHR_WRITE]
    );
    this.write  = characteristics.find(c => c.uuid.endsWith(CHR_WRITE));
    this.notify = characteristics.find(c => c.uuid.endsWith(CHR_NOTIFY));
    if (!this.write || !this.notify) throw new Error('Wilink characteristics not found');

    this.notify.on('data', (chunk) => this._onData(chunk));
    await this.notify.subscribeAsync();
  }

  _onData(chunk) {
    this.rx = Buffer.concat([this.rx, chunk]);
    while (true) {
      const start = this.rx.indexOf(0xF8);
      if (start < 0) { this.rx = Buffer.alloc(0); break; }
      const end = this.rx.indexOf(0xFD, start);
      if (end < 0) { this.rx = this.rx.slice(start); break; }
      const f = this.rx.slice(start, end + 1);
      this.rx = this.rx.slice(end + 1);
      const ev = parseFrame(f);
      if (ev) this.listeners.forEach(fn => { try { fn(ev); } catch {} });
    }
  }

  async send(buf, withResponse = false) {
    await this.write.writeAsync(buf, !withResponse);
    await new Promise(r => setTimeout(r, 30));
  }

  async disconnect() { try { await this.p.disconnectAsync(); } catch {} }
}

async function findFirst(timeoutMs = 15000) {
  await new Promise(r => {
    if (noble.state === 'poweredOn') return r();
    noble.once('stateChange', s => s === 'poweredOn' && r());
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { noble.stopScanning(); reject(new Error('scan timeout')); }, timeoutMs);
    noble.once('discover', async (p) => {
      clearTimeout(t);
      await noble.stopScanningAsync();
      resolve(p);
    });
    noble.startScanningAsync([SVC_WILINK], false);
  });
}

async function main() {
  console.log('scanning for WalkingPad…');
  const peripheral = await findFirst();
  console.log('found', peripheral.advertisement.localName, peripheral.address);
  const pad = new WalkingPad(peripheral);

  pad.on(ev => {
    if (ev.kind === 'status') {
      process.stdout.write(
        `\rstate=${ev.beltState} mode=${ev.mode} speed=${ev.speed.toFixed(1)} km/h  ` +
        `t=${ev.time}s  d=${ev.distance.toFixed(2)}km  steps=${ev.steps}    `
      );
    } else if (ev.kind === 'lastSession') {
      console.log('\n[session ended]', ev);
    }
  });

  await pad.connect();
  console.log('connected, taking control');

  await pad.send(CMD.setMode(MODE.MANUAL));
  await pad.send(CMD.start());
  await pad.send(CMD.setSpeed(2.0));

  const poll = setInterval(() => pad.send(CMD.status()), 1000);

  // 30-second demo, then stop and bail
  setTimeout(async () => {
    clearInterval(poll);
    await pad.send(CMD.stop());
    await new Promise(r => setTimeout(r, 1500));
    await pad.disconnect();
    process.exit(0);
  }, 30000);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { WalkingPad, CMD, MODE, frame, checksum, parseFrame };
