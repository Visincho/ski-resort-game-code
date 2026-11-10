// Synthesises the original 40 s trailer soundtrack (120 BPM, A minor) as a 44.1 kHz stereo WAV.
// No samples, no third-party audio: free to use on any social platform.
// Usage: node tools/make-music.mjs promo/music.wav
import fs from 'node:fs';

const SR = 44100, BPM = 120, BEAT = 60 / BPM, BAR = BEAT * 4, DUR = 40;
const N = Math.ceil(SR * (DUR + 0.5));
const L = new Float32Array(N), R = new Float32Array(N);
const sendL = new Float32Array(N), sendR = new Float32Array(N); // reverb send
const duck = new Float32Array(N).fill(1); // kick sidechain
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class SVF { // TPT state-variable filter
  constructor() { this.a = 0; this.b = 0; }
  run(x, fc, q = 0.7, mode = 'lp') {
    const g = Math.tan(Math.PI * clamp(fc, 20, SR * 0.45) / SR), k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - this.b, v1 = a1 * this.a + a2 * v3, v2 = this.b + a2 * this.a + a3 * v3;
    this.a = 2 * v1 - this.a; this.b = 2 * v2 - this.b;
    return mode === 'lp' ? v2 : mode === 'bp' ? v1 : x - k * v1 - v2;
  }
}
const add = (i, l, r, send = 0) => { if (i < 0 || i >= N) return; L[i] += l; R[i] += r; sendL[i] += l * send; sendR[i] += r * send; };

// arrangement helpers -----------------------------------------------------------------
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
const chordAt = t => CHORDS[Math.floor(t / BAR) % 4];
const section = t => (t < 8 ? 'intro' : t < 22 ? 'groove' : t < 25 ? 'break' : t < 35 ? 'drop' : 'outro');

// ---------- drums ----------
function kick(t0, gain = 1) {
  const s0 = Math.floor(t0 * SR);
  let ph = 0;
  for (let i = 0; i < SR * 0.45; i++) {
    const t = i / SR;
    const f = 45 + 110 * Math.exp(-t * 28);
    ph += (2 * Math.PI * f) / SR;
    const v = Math.sin(ph) * Math.exp(-t * 7) * gain + (i < 90 ? (rnd() * 2 - 1) * 0.25 * (1 - i / 90) : 0);
    add(s0 + i, v * 0.9, v * 0.9);
  }
  for (let i = 0; i < SR * 0.3; i++) { const j = s0 + i; if (j < N) duck[j] = Math.min(duck[j], 0.35 + 0.65 * (i / (SR * 0.3)) ** 0.7); }
}
function clap(t0, gain = 1) {
  const s0 = Math.floor(t0 * SR), f = new SVF();
  for (let i = 0; i < SR * 0.25; i++) {
    const t = i / SR;
    const burst = t < 0.03 ? (Math.floor(t / 0.01) % 2 === 0 ? 1 : 0.3) : 1;
    const v = f.run(rnd() * 2 - 1, 1600, 1.2, 'bp') * Math.exp(-t * 18) * burst * 0.9 * gain;
    add(s0 + i, v * 0.9, v * 1.0, 0.35);
  }
}
function hat(t0, open = false, gain = 1) {
  const s0 = Math.floor(t0 * SR), f = new SVF();
  const len = open ? 0.28 : 0.05;
  for (let i = 0; i < SR * len; i++) {
    const t = i / SR;
    const v = f.run(rnd() * 2 - 1, 8000, 0.8, 'hp') * Math.exp(-t * (open ? 10 : 70)) * 0.32 * gain;
    add(s0 + i, v * (open ? 0.9 : 0.7), v * (open ? 0.7 : 0.9), 0.1);
  }
}
function crash(t0, gain = 1) {
  const s0 = Math.floor(t0 * SR), f = new SVF();
  for (let i = 0; i < SR * 2.2; i++) {
    const t = i / SR;
    const v = f.run(rnd() * 2 - 1, 6000, 0.6, 'hp') * Math.exp(-t * 2.2) * 0.35 * gain;
    add(s0 + i, v * (0.9 + 0.1 * Math.sin(t * 9)), v, 0.4);
  }
}
function impact(t0, gain = 1) {
  const s0 = Math.floor(t0 * SR), f = new SVF();
  let ph = 0;
  for (let i = 0; i < SR * 2.5; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (32 + 90 * Math.exp(-t * 6))) / SR;
    const boom = Math.sin(ph) * Math.exp(-t * 1.6);
    const noise = f.run(rnd() * 2 - 1, 900 * Math.exp(-t * 1.5) + 80, 0.7) * Math.exp(-t * 3);
    const v = (boom * 0.9 + noise * 0.7) * gain;
    add(s0 + i, v, v, 0.5);
  }
  for (let i = 0; i < SR * 0.6; i++) { const j = s0 + i; if (j < N) duck[j] = Math.min(duck[j], 0.2 + 0.8 * (i / (SR * 0.6))); }
}
function riser(t0, t1, gain = 1) {
  const s0 = Math.floor(t0 * SR), n = Math.floor((t1 - t0) * SR), f = new SVF();
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const v = f.run(rnd() * 2 - 1, 300 + 9000 * u * u, 2.5, 'bp') * u * u * 0.6 * gain;
    add(s0 + i, v * (1 - 0.3 * u), v * (0.7 + 0.3 * u), 0.4);
  }
}
function snareRoll(t0, t1) {
  for (let t = t0, k = 0; t < t1; k++) {
    const u = (t - t0) / (t1 - t0);
    clap(t, 0.25 + 0.75 * u);
    t += u < 0.5 ? BEAT / 2 : u < 0.8 ? BEAT / 4 : BEAT / 8;
  }
}

// ---------- tonal ----------
function saw(ph) { return 2 * (ph - Math.floor(ph + 0.5)); }
function pad(t0, t1, notes, gain, cutoff) {
  const s0 = Math.floor(t0 * SR), n = Math.floor((t1 - t0) * SR);
  const fl = new SVF(), fr = new SVF();
  const voices = [];
  for (const m of notes) for (let d = -2; d <= 2; d++) voices.push({ f: mtof(m) * (1 + d * 0.0045), ph: rnd(), pan: d / 2.5 });
  for (let i = 0; i < n; i++) {
    const t = t0 + i / SR;
    const env = Math.min(1, i / (SR * 0.35)) * Math.min(1, (n - i) / (SR * 0.25));
    let l = 0, r = 0;
    for (const v of voices) { v.ph += v.f / SR; const s = saw(v.ph); l += s * (0.5 - v.pan * 0.4); r += s * (0.5 + v.pan * 0.4); }
    const fc = cutoff(t);
    const g = gain * env / voices.length * 2.2 * duck[s0 + i];
    add(s0 + i, fl.run(l, fc, 0.8) * g, fr.run(r, fc, 0.8) * g, 0.45);
  }
}
function pluck(t0, m, gain = 1, len = 0.22, bright = 4000) {
  const s0 = Math.floor(t0 * SR), f = new SVF();
  let ph = rnd(), ph2 = rnd();
  const fr = mtof(m);
  for (let i = 0; i < SR * len; i++) {
    const t = i / SR;
    ph += fr / SR; ph2 += (fr * 1.005) / SR;
    const x = (saw(ph) + (ph2 % 1 < 0.5 ? 0.6 : -0.6)) * 0.5;
    const v = f.run(x, 300 + bright * Math.exp(-t * 18), 1.1) * Math.exp(-t * 9) * 0.5 * gain;
    const pan = Math.sin(t0 * 3.1) * 0.35;
    add(s0 + i, v * (1 - pan), v * (1 + pan), 0.3);
  }
}
function bass(t0, m, len, gain = 1) {
  const s0 = Math.floor(t0 * SR), f = new SVF();
  let ph = 0, sub = 0;
  const fr = mtof(m);
  for (let i = 0; i < SR * len; i++) {
    const t = i / SR;
    ph += fr / SR; sub += (fr / 2) / SR;
    const x = saw(ph) * 0.6 + Math.sin(sub * 2 * Math.PI) * 0.8;
    const env = Math.min(1, i / 60) * Math.exp(-t * 2.5);
    const v = f.run(x, 220 + 900 * Math.exp(-t * 12), 0.9) * env * 0.55 * gain * duck[s0 + i];
    add(s0 + i, v, v);
  }
}
function lead(t0, m, len, gain = 1) {
  const s0 = Math.floor(t0 * SR), f = new SVF();
  let p1 = rnd(), p2 = rnd();
  const fr = mtof(m);
  for (let i = 0; i < SR * len; i++) {
    const t = i / SR;
    const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 3);
    p1 += (fr * vib) / SR; p2 += (fr * vib * 1.007) / SR;
    const x = saw(p1) + saw(p2);
    const env = Math.min(1, i / 400) * Math.min(1, (SR * len - i) / 800);
    const v = f.run(x, 2600, 0.9) * env * 0.16 * gain;
    add(s0 + i, v * 0.85, v, 0.55);
    // echo (dotted eighth)
    const d = Math.floor(SR * BEAT * 0.75);
    add(s0 + i + d, v * 0.25, v * 0.4, 0.3);
  }
}

// ---------- arrangement ----------
// drums
for (let b = 0; b < 20; b++) {
  const tb = b * BAR;
  const sec = section(tb + 0.01);
  for (let q = 0; q < 4; q++) {
    const t = tb + q * BEAT;
    const sq = section(t + 0.01);
    if (sq === 'groove' || sq === 'drop') {
      kick(t, sq === 'drop' ? 1.05 : 0.95);
      if (q % 2 === 1) clap(t, sq === 'drop' ? 1 : 0.85);
      hat(t + BEAT / 2, sq === 'drop' && q % 2 === 1, 0.9);
      if (sq === 'drop') { hat(t + BEAT / 4, false, 0.45); hat(t + BEAT * 0.75, false, 0.45); }
    } else if (sq === 'intro' && b >= 2) {
      if (q === 0) kick(t, 0.45);
      hat(t + BEAT / 2, false, 0.35);
    } else if (sq === 'break' && q === 0) kick(t, 0.5);
  }
  void sec;
}
// impacts & transitions on the trailer cuts
riser(5.5, 8); impact(8, 1); crash(8);
crash(14, 0.5); crash(18, 0.6); crash(20, 0.45);
riser(23, 25, 1.1); snareRoll(23, 25); impact(25, 0.9); crash(25);
crash(31, 0.6);
riser(33.5, 35, 0.8); impact(35, 1.1); crash(35, 1.1);
// chords / pad (filter opens through the intro, dips in the break)
for (let b = 0; b < 20; b++) {
  const t0 = b * BAR, t1 = t0 + BAR;
  if (t0 >= 36) break;
  const notes = chordAt(t0 + 0.01);
  const cutoff = t => {
    const s = section(t);
    if (s === 'intro') return 400 + 2200 * (t / 8) ** 1.5;
    if (s === 'break') return 900 + 1500 * ((t - 22) / 3);
    if (s === 'outro') return 2400;
    return 3200;
  };
  pad(t0, Math.min(t1 + 0.05, 36), notes.concat([notes[0] - 12]), section(t0 + 0.01) === 'break' ? 0.9 : 0.75, cutoff);
}
pad(35, 40, [57, 60, 64, 69, 45], 0.85, t => 2800 - (t - 35) * 350);
// arp: 16ths from bar 2, the chord tones climbing
const ARP = [0, 1, 2, 3, 2, 1, 2, 3];
for (let t = 4; t < 35; t += BEAT / 4) {
  const s = section(t + 0.001);
  const ch = chordAt(t + 0.001);
  const tones = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[0] + 24];
  const step = Math.round(t / (BEAT / 4));
  const m = tones[ARP[step % 8]];
  pluck(t, m, s === 'intro' ? 0.45 * ((t - 4) / 4) : s === 'break' ? 0.6 : 0.75, 0.2, s === 'drop' ? 5200 : 3800);
}
// bass on 8ths in groove/drop
for (let t = 8; t < 35; t += BEAT / 2) {
  const s = section(t + 0.001);
  if (s === 'break') continue;
  const root = chordAt(t + 0.001)[0] - 24;
  const oct = Math.round(t / (BEAT / 2)) % 2 ? 12 : 0;
  bass(t, root + oct, BEAT / 2 * 0.95, s === 'drop' ? 1.1 : 1);
}
// lead hook in the drop (25-35)
const HOOK = [[0, 76, 1], [1, 74, 0.5], [1.5, 72, 0.5], [2, 71, 1], [3, 69, 1], [4, 72, 1.5], [5.5, 74, 0.5], [6, 76, 1.5], [7.5, 79, 0.5]];
for (const rep of [0, 4]) for (const [b, m, d] of HOOK) {
  const t = 25 + (rep + b * 0.5) * BEAT * 2;
  if (t < 35) lead(t, m, d * BEAT, 1);
}
// logo sting
[69, 72, 76, 81].forEach((m, i) => pluck(35.0 + i * 0.09, m, 0.9, 1.6, 6000));
lead(35.2, 81, 2.5, 0.8);

// ---------- reverb (Schroeder) on the send bus ----------
function reverb(inp, out, delays, seedOff) {
  const combs = delays.map(d => ({ buf: new Float32Array(d), i: 0, fb: 0.78, lp: 0 }));
  const aps = [556 + seedOff, 441 + seedOff].map(d => ({ buf: new Float32Array(d), i: 0 }));
  for (let n = 0; n < N; n++) {
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.lp = o * 0.7 + c.lp * 0.3;
      c.buf[c.i] = inp[n] + c.lp * c.fb;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    y /= combs.length;
    for (const a of aps) { const o = a.buf[a.i]; const v = y + o * 0.5; a.buf[a.i] = v; y = o - v * 0.5; a.i = (a.i + 1) % a.buf.length; }
    out[n] += y * 0.55;
  }
}
reverb(sendL, L, [1557, 1617, 1491, 1422], 0);
reverb(sendR, R, [1580, 1640, 1516, 1445], 23);

// ---------- master: fade, soft clip, normalise ----------
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fade = (t < 0.3 ? t / 0.3 : 1) * (t > 38.4 ? Math.max(0, (40 - t) / 1.6) : 1);
  L[i] = Math.tanh(L[i] * 0.9) * fade;
  R[i] = Math.tanh(R[i] * 0.9) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.89 / peak;
const total = SR * DUR;
const buf = Buffer.alloc(44 + total * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(total * 4, 40);
for (let i = 0; i < total; i++) {
  buf.writeInt16LE(Math.round(clamp(L[i] * norm, -1, 1) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(clamp(R[i] * norm, -1, 1) * 32767), 46 + i * 4);
}
const outPath = process.argv[2] || 'promo/music.wav';
fs.writeFileSync(outPath, buf);
console.log('wrote', outPath, (buf.length / 1e6).toFixed(1), 'MB');
