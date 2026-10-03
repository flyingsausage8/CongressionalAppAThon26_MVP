// Generates the forest sound effects as WAV files.
// Synthesized in code, so there is nothing to licence and nothing to download.
// Tuned to be warm and pleasant - no filtered-noise horror drones.
import fs from 'node:fs';
import path from 'node:path';

const RATE = 24000;
const OUT = 'public/sfx';
fs.mkdirSync(OUT, { recursive: true });

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const secs = (s) => new Float32Array(Math.round(RATE * s));
const noise = () => Math.random() * 2 - 1;

const fade = (buf, inS = 0.08, outS = 0.25) => {
  const a = Math.round(inS * RATE);
  const b = Math.round(outS * RATE);
  for (let i = 0; i < a; i++) buf[i] *= i / a;
  for (let i = 0; i < b; i++) buf[buf.length - 1 - i] *= i / b;
  return buf;
};

function lowpass(buf, cutoff) {
  const a = Math.exp((-2 * Math.PI * cutoff) / RATE);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y = (1 - a) * buf[i] + a * y;
    buf[i] = y;
  }
  return buf;
}

function highpass(buf, cutoff) {
  const a = Math.exp((-2 * Math.PI * cutoff) / RATE);
  let prevIn = 0, prevOut = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    prevOut = a * (prevOut + x - prevIn);
    prevIn = x;
    buf[i] = prevOut;
  }
  return buf;
}

/** A single bird chirp: a short rising or falling whistle with a bell envelope. */
function chirp(buf, atSec, f0, f1, durSec, gain) {
  const start = Math.round(atSec * RATE);
  const n = Math.round(durSec * RATE);
  let phase = 0;
  for (let i = 0; i < n && start + i < buf.length; i++) {
    const t = i / n;
    phase += (2 * Math.PI * (f0 + (f1 - f0) * t)) / RATE;
    const env = Math.sin(Math.PI * t) ** 1.5;
    buf[start + i] += Math.sin(phase) * env * gain;
  }
}

const SFX = {
  birdsong() {
    const b = secs(3.2);
    for (let i = 0; i < b.length; i++) b[i] = noise() * 0.012;
    lowpass(b, 900);
    const songs = [
      [0.15, 2300, 3100, 0.09], [0.30, 3100, 2500, 0.07], [0.44, 2700, 2700, 0.06],
      [0.95, 1900, 2600, 0.08], [1.08, 2600, 2100, 0.07],
      [1.55, 3000, 3600, 0.06], [1.66, 3600, 2900, 0.06], [1.78, 3200, 3200, 0.05],
      [2.25, 2100, 2800, 0.08], [2.40, 2800, 2200, 0.07], [2.52, 2400, 2400, 0.05],
    ];
    for (const [at, f0, f1, dur] of songs) chirp(b, at, f0, f1, dur, 0.3);
    return fade(b, 0.12, 0.5);
  },

  footsteps_leaves() {
    const b = secs(2.4);
    for (let s = 0; s < 4; s++) {
      const at = Math.round((0.15 + s * 0.55) * RATE);
      const n = Math.round(0.16 * RATE);
      for (let i = 0; i < n && at + i < b.length; i++) {
        const t = i / n;
        const grain = Math.random() < 0.5 - 0.35 * t ? noise() : 0;
        b[at + i] += grain * Math.exp(-t * 5) * 0.4;
      }
    }
    highpass(b, 600);
    lowpass(b, 7000);
    return fade(b, 0.02, 0.2);
  },

  wind_in_trees() {
    const b = secs(3.5);
    for (let i = 0; i < b.length; i++) b[i] = noise();
    lowpass(b, 2200);
    highpass(b, 350);
    for (let i = 0; i < b.length; i++) {
      const t = i / RATE;
      const swell =
        0.45 + 0.4 * Math.sin(2 * Math.PI * 0.28 * t) + 0.15 * Math.sin(2 * Math.PI * 0.11 * t);
      b[i] *= swell * 0.3;
    }
    return fade(b, 0.5, 0.7);
  },

  brook() {
    const b = secs(3.2);
    for (let i = 0; i < b.length; i++) b[i] = noise() * 0.22;
    highpass(b, 1200);
    lowpass(b, 6500);
    for (let k = 0; k < 90; k++) {
      const at = (Math.random() * (b.length - 2000)) | 0;
      const f = 900 + Math.random() * 2200;
      const n = 300 + ((Math.random() * 500) | 0);
      for (let i = 0; i < n; i++) {
        b[at + i] += Math.sin((2 * Math.PI * f * i) / RATE) * Math.exp(-i / (n * 0.3)) * 0.05;
      }
    }
    return fade(b, 0.3, 0.6);
  },

  door_knock() {
    const b = secs(1.8);
    for (const at of [0.1, 0.45, 0.8]) {
      const s = Math.round(at * RATE);
      const n = Math.round(0.22 * RATE);
      for (let i = 0; i < n && s + i < b.length; i++) {
        const t = i / n;
        const env = Math.exp(-t * 14);
        b[s + i] +=
          (Math.sin((2 * Math.PI * 165 * i) / RATE) * 0.5 +
            Math.sin((2 * Math.PI * 240 * i) / RATE) * 0.3 +
            noise() * Math.exp(-t * 60) * 0.6) * env * 0.45;
      }
    }
    lowpass(b, 2600);
    return fade(b, 0.01, 0.25);
  },

  basket_rustle() {
    const b = secs(1.6);
    for (let i = 0; i < b.length; i++) {
      const t = i / b.length;
      const density = 0.35 * Math.sin(Math.PI * t) ** 2;
      b[i] = (Math.random() < density ? noise() : 0) * 0.28;
    }
    highpass(b, 1500);
    lowpass(b, 9000);
    const s = Math.round(0.6 * RATE);
    for (let i = 0; i < 4000 && s + i < b.length; i++) {
      b[s + i] += Math.sin((2 * Math.PI * (420 + i * 0.03) * i) / RATE) * Math.exp(-i / 1400) * 0.06;
    }
    return fade(b, 0.05, 0.3);
  },
};

for (const [name, gen] of Object.entries(SFX)) {
  fs.writeFileSync(path.join(OUT, `${name}.wav`), wav(gen()));
  console.log(`  ${name}.wav`);
}
console.log(`\n  ${Object.keys(SFX).length} forest sounds written to ${path.resolve(OUT)}\n`);
