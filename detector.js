// VigíaRuta · drowsiness detector core (pure logic, no DOM). Used by index.html and by test_detector.mjs.
// Input per frame: null (no face) or { blink, jaw, ear, mar, pitch, roll, noseY } where
//   blink = mean eyeBlink blendshape (0..1), jaw = jawOpen blendshape (0..1), ear = eye aspect ratio,
//   mar = mouth aspect ratio, pitch/roll = head angles in degrees (pitch > 0 = head down), noseY = nose tip
//   height relative to face height (head translation proxy).

export const SENS = { alta: 0.42, media: 0.52, baja: 0.62 };   // eye "closedness" threshold
export const DEFAULTS = {
  sensitivity: 'media',
  alarmSec: 2,        // loud alarm when eyes stay closed this long
  microsleepSec: 1,   // a closure this long counts as a microsleep
  yawnSec: 1.2,       // mouth wide open this long = yawn
  nodSec: 0.5,        // head dropped/tilted this long = nod (was 1.2 s)
  nodDownDeg: 14,     // head-down angle vs calibration
  nodUpDeg: 20,       // head falling back
  nodRollDeg: 22,     // head falling to one side
  yawnStop: 3,        // ask to stop after this many yawns in 10 min
  microsleepStop: 2,
  nodStop: 2,
  calibSec: 4,
};

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export class Detector {
  constructor(cfg = {}) { this.cfg = Object.assign({}, DEFAULTS, cfg); this.reset(0); this.calib = null;
    this.base = { ear: 0.28, blink: 0.08, pitch: 0, roll: 0, noseY: null }; }

  setConfig(cfg) { Object.assign(this.cfg, cfg); }

  reset(now) {
    this.samples = []; this.blinks = []; this.longs = []; this.yawns = []; this.nods = [];
    this.closed = false; this.closedSince = null; this.openSince = now; this.longCounted = false; this.closedness = 0;
    this.yawnSince = null; this.yawnLast = -1e9; this.yawnCounted = false; this.lastYawnEnd = -1e9;
    this.nodSince = null; this.nodCounted = false; this.nodKind = '';
    this.pitchHist = []; this.lastFace = now; this.faceLostWarned = false;
    this.alarmOn = false; this.alarmAt = 0; this.alarmWhy = '';
    this.score = 0; this.perclos = null; this.avgBlink = null; this.lastEval = -1e9;
    this.lastStop = { yawn: -1e9, microsleep: -1e9, nod: -1e9, score: -1e9, perclos: -1e9 };
  }

  startCalibration(now) { this.calib = { t0: now, ears: [], blinks: [], pitches: [], rolls: [], noses: [] }; }

  get yawning() { return this.yawnSince !== null; }

  // Eye closure while yawning (or just after) is the yawn squint, not a microsleep.
  get yawnMasked() { return this.yawning || this._now - this.lastYawnEnd < 600; }

  update(f, now) {
    this._now = now;
    const ev = [];
    const c = this.cfg;

    if (!f) { this._noFace(now, ev); this._evaluate(now, ev); return ev; }
    if (this.faceLostWarned) { this.faceLostWarned = false; ev.push({ type: 'face_back' }); }
    this.lastFace = now; this.lossNodCounted = false;

    if (this.calib) {
      const k = this.calib; k.ears.push(f.ear); k.blinks.push(f.blink);
      if (f.pitch != null) k.pitches.push(f.pitch); if (f.roll != null) k.rolls.push(f.roll); if (f.noseY != null) k.noses.push(f.noseY);
      if (now - k.t0 >= c.calibSec * 1000 && k.ears.length >= 20) {
        const sorted = [...k.ears].sort((a, b) => b - a);
        this.base.ear = Math.max(0.15, median(sorted.slice(0, Math.ceil(sorted.length * 0.6))));
        this.base.blink = clamp(median(k.blinks), 0, 0.5);
        this.base.pitch = k.pitches.length ? median(k.pitches) : 0;
        this.base.roll = k.rolls.length ? median(k.rolls) : 0;
        this.base.noseY = k.noses.length ? median(k.noses) : null;
        this.calib = null; this.openSince = now;
        ev.push({ type: 'calibrated', base: { ...this.base } });
      }
      return ev;
    }

    // ---- Yawn (evaluated first so it can mask the squint that comes with it) ----
    const mouthWide = f.jaw > 0.5 || f.mar > 0.55;
    if (mouthWide) {
      if (this.yawnSince === null) this.yawnSince = now;
      this.yawnLast = now;
      if (!this.yawnCounted && now - this.yawnSince >= c.yawnSec * 1000) {
        this.yawnCounted = true; this.yawns.push(now);
        ev.push({ type: 'yawn', count: this._count(this.yawns, now) });
        this._maybeStop('yawn', this._count(this.yawns, now) >= c.yawnStop, `${this._count(this.yawns, now)} bostezos en 10 min`, now, ev);
      }
    } else if (this.yawnSince !== null && now - this.yawnLast > 350) {
      if (this.yawnCounted) this.lastYawnEnd = now;
      this.yawnSince = null; this.yawnCounted = false;
    }

    // ---- Eye closure (blendshape + eye aspect ratio, relative to calibration, with hysteresis) ----
    const blinkAdj = clamp((f.blink - this.base.blink) / Math.max(0.3, 1 - this.base.blink));
    const earAdj = clamp((this.base.ear - f.ear) / (this.base.ear * 0.55));
    const closedness = 0.55 * blinkAdj + 0.45 * earAdj;
    const thr = SENS[c.sensitivity] ?? SENS.media;
    this.closedness = closedness;
    this.closed = this.closed ? closedness > thr - 0.1 : closedness > thr;
    if (this.closed) {
      if (this.closedSince === null) this.closedSince = now;
      this.openSince = null;
    } else {
      if (this.closedSince !== null) this._endClosure(now, ev);
      if (this.openSince === null) this.openSince = now;
    }
    this.samples.push({ t: now, c: this.closed && !this.yawnMasked ? 1 : 0 });

    // ---- Head nod: head drops, falls back or to one side for ≥ nodSec ----
    if (f.pitch != null) {
      this.pitchHist.push(f.pitch); if (this.pitchHist.length > 3) this.pitchHist.shift();
      const dp = median(this.pitchHist) - this.base.pitch;
      const dr = f.roll != null ? Math.abs(f.roll - this.base.roll) : 0;
      const drop = this.base.noseY != null && f.noseY != null ? f.noseY - this.base.noseY : 0;
      let kind = '';
      if (dp > c.nodDownDeg || drop > 0.12) kind = 'la cabeza cayó hacia adelante';
      else if (dp < -c.nodUpDeg) kind = 'la cabeza cayó hacia atrás';
      else if (dr > c.nodRollDeg) kind = 'la cabeza cayó hacia un lado';
      if (dp > c.nodDownDeg * 0.6 || drop > 0.07) this.lastDownAt = now;   // head going down (pre-drop)
      if (kind) {
        if (this.nodSince === null) { this.nodSince = now; this.nodKind = kind; }
        if (!this.nodCounted && now - this.nodSince >= c.nodSec * 1000) this._countNod(now, ev);
      } else { this.nodSince = null; this.nodCounted = false; }
      this.dp = dp;
    }

    this._evaluate(now, ev);
    return ev;
  }

  _countNod(now, ev) {
    this.nodCounted = true; this.nods.push(now);
    const n = this._count(this.nods, now);
    ev.push({ type: 'nod', count: n, kind: this.nodKind });
    this._maybeStop('nod', n >= this.cfg.nodStop, `${n} cabeceos en 10 min`, now, ev);
  }

  _endClosure(now, ev) {
    const dur = now - this.closedSince;
    if (dur >= 60 && dur < this.cfg.microsleepSec * 1000) this.blinks.push({ t: now, dur });
    if (dur >= this.cfg.microsleepSec * 1000) ev.push({ type: 'closure_end', dur });
    this.closedSince = null; this.longCounted = false;
  }

  _noFace(now, ev) {
    if (this.calib) return;
    const gone = now - this.lastFace;
    if (gone > 3000 && !this.faceLostWarned) { this.faceLostWarned = true; ev.push({ type: 'face_lost' }); }
    // Face vanished in the middle of a head drop: that is a nod (the head fell out of view).
    if (this.nodSince !== null && !this.nodCounted && now - this.nodSince >= this.cfg.nodSec * 1000) { this._countNod(now, ev); this.lossNodCounted = true; }
    else if (!this.nodCounted && !this.lossNodCounted && this.lastFace - (this.lastDownAt ?? -1e9) < 350 && gone >= this.cfg.nodSec * 1000) {
      this.lossNodCounted = true; this.nodKind = 'la cabeza cayó y salió de cuadro'; if (this.nodSince === null) this.nodSince = this.lastFace; this._countNod(now, ev);
    }
    // Face vanished while the eyes were closed: keep the closure running (head likely fell).
    if (this.closedSince === null && gone > 1500) this.openSince = null;
  }

  _maybeStop(key, cond, reason, now, ev, cooldown = 120000) {
    if (!cond || now - this.lastStop[key] < cooldown) return;
    this.lastStop[key] = now;
    ev.push({ type: 'stop', key, reason });
  }

  _count(arr, now) { return arr.filter(t => t > now - 600000).length; }

  ack(now) { this.closedSince = null; this.longCounted = false; this.closed = false; this.openSince = now; this.alarmOn = false; }

  _evaluate(now, ev) {
    if (this.calib) return;
    const c = this.cfg;
    const faceLost = now - this.lastFace > 300;

    // Microsleep + loud alarm on a continuous closure (works even if the face is lost mid-closure)
    if (this.closedSince !== null) {
      const dur = now - this.closedSince;
      const masked = this.yawnMasked;
      if (!this.longCounted && !masked && dur >= c.microsleepSec * 1000) {
        this.longCounted = true; this.longs.push(now);
        const n = this._count(this.longs, now);
        ev.push({ type: 'microsleep', count: n });
        this._maybeStop('microsleep', n >= c.microsleepStop, `${n} microsueños en 10 min`, now, ev);
      }
      const limit = (c.alarmSec + (faceLost ? 1 : 0) + (masked ? 2 : 0)) * 1000;
      if (!this.alarmOn && dur >= limit) this._alarm(now, `Ojos cerrados por más de ${(+c.alarmSec).toFixed(1)} segundos`, ev);
    }
    // Head down (or out of view after dropping) for a long time
    if (this.nodSince !== null && !this.alarmOn && now - this.nodSince >= (c.alarmSec + 1.5) * 1000 &&
        (this.closedSince !== null || faceLost)) this._alarm(now, 'Cabeza caída y ojos cerrados', ev);

    if (this.alarmOn && !this.closed && this.openSince !== null && now - this.openSince > 1500 &&
        now - this.alarmAt > 3000 && !faceLost && this.nodSince === null) {
      this.alarmOn = false; ev.push({ type: 'alarm_end' });
    }

    if (now - this.lastEval < 500) return;
    this.lastEval = now;
    const T60 = now - 60000, T10 = now - 600000;
    this.samples = this.samples.filter(s => s.t > T60); this.blinks = this.blinks.filter(b => b.t > T60);
    this.longs = this.longs.filter(t => t > T10); this.yawns = this.yawns.filter(t => t > T10); this.nods = this.nods.filter(t => t > T10);
    const span = this.samples.length ? now - this.samples[0].t : 0;
    this.perclos = this.samples.length && span > 30000 ? this.samples.reduce((a, s) => a + s.c, 0) / this.samples.length : null;
    this.avgBlink = this.blinks.length >= 3 ? this.blinks.reduce((a, b) => a + b.dur, 0) / this.blinks.length : null;

    let s = 0;
    if (this.perclos !== null) s += Math.min(40, this.perclos * 160);
    s += Math.min(30, this.yawns.length * 10);
    s += Math.min(30, this.longs.length * 15);
    if (this.avgBlink !== null && this.avgBlink > 220) s += Math.min(15, (this.avgBlink - 220) / 8);
    s += Math.min(30, this.nods.length * 15);
    this.score = this.score * 0.75 + Math.min(100, s) * 0.25;
    const sc = Math.round(this.score);
    if (!this.alarmOn) {
      this._maybeStop('score', sc >= 55, `nivel de fatiga ${sc}/100`, now, ev, 180000);
      this._maybeStop('perclos', this.perclos !== null && this.perclos > 0.15,
        `ojos cerrados el ${(this.perclos * 100).toFixed(0)}% del último minuto`, now, ev, 180000);
    }
  }

  _alarm(now, why, ev) { this.alarmOn = true; this.alarmAt = now; this.alarmWhy = why; ev.push({ type: 'alarm', why }); }

  stats(now) {
    return { score: Math.round(this.score), perclos: this.perclos, avgBlink: this.avgBlink,
      yawns: this._count(this.yawns, now), microsleeps: this._count(this.longs, now), nods: this._count(this.nods, now),
      closed: this.closed, closedFor: this.closedSince !== null ? now - this.closedSince : 0, closedness: this.closedness,
      alarmOn: this.alarmOn, calibrating: !!this.calib, yawning: this.yawning, faceLost: now - this.lastFace > 300 };
  }
}
