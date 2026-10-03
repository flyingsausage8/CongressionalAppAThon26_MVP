// Generates the sound effects as WAV files - synthesized, no downloads, no licences.
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
const env = (i, n, attack = 0.01, release = 0.3) => {
  const t = i / n;
  return Math.min(1, t / attack) * Math.min(1, (1 - t) / release);
};

// one-pole low-pass, keeps rumble from sounding like hiss
function lowpass(buf, cutoff) {
  const a = Math.exp((-2 * Math.PI * cutoff) / RATE);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y = (1 - a) * buf[i] + a * y;
    buf[i] = y;
  }
  return buf;
}

const SFX = {
  turn_signal() {
    const b = secs(1.0);
    for (const start of [0, 0.5]) {
      const s = Math.round(start * RATE);
      for (let i = 0; i < 700; i++) b[s + i] += noise() * Math.exp(-i / 90) * 0.55;
    }
    return b;
  },

  radio_static() {
    const b = secs(1.4);
    for (let i = 0; i < b.length; i++) b[i] = noise() * env(i, b.length, 0.02, 0.5) * 0.3;
    lowpass(b, 4000);
    for (let i = 0; i < b.length; i++) b[i] *= 1 + 0.4 * Math.sin(i / 400);
    return b;
  },

  engine_rumble() {
    const b = secs(2.5);
    for (let i = 0; i < b.length; i++) {
      const t = i / RATE;
      const throb = 1 + 0.18 * Math.sin(2 * Math.PI * 2.1 * t);
      b[i] =
        (Math.sin(2 * Math.PI * 48 * t) * 0.5 +
          Math.sin(2 * Math.PI * 97 * t) * 0.22 +
          noise() * 0.25) * throb * env(i, b.length, 0.08, 0.2) * 0.45;
    }
    lowpass(b, 300);
    return b;
  },

  rumble_strip() {
    const b = secs(1.6);
    for (let i = 0; i < b.length; i++) {
      const t = i / RATE;
      const pulse = Math.sign(Math.sin(2 * Math.PI * 42 * t)) * 0.5 + 0.5;
      b[i] = noise() * pulse * env(i, b.length, 0.03, 0.25) * 0.5;
    }
    lowpass(b, 1800);
    return b;
  },

  thunder() {
    const b = secs(3.0);
    for (let i = 0; i < b.length; i++) b[i] = noise() * env(i, b.length, 0.15, 0.6) * 0.6;
    lowpass(b, 180);
    for (let i = 0; i < b.length; i++) b[i] *= 1 + 0.5 * Math.sin(i / 9000);
    return b;
  },

  horn_distant() {
    const b = secs(1.8);
    for (let i = 0; i < b.length; i++) {
      const t = i / RATE;
      b[i] =
        (Math.sin(2 * Math.PI * 185 * t) + Math.sin(2 * Math.PI * 233 * t) * 0.7) *
        env(i, b.length, 0.1, 0.45) * 0.22;
    }
    lowpass(b, 1200);
    return b;
  },
};

for (const [name, gen] of Object.entries(SFX)) {
  fs.writeFileSync(path.join(OUT, `${name}.wav`), wav(gen()));
  console.log(`  ${name}.wav`);
}
console.log(`\n  ${Object.keys(SFX).length} sound effects written to ${path.resolve(OUT)}\n`);
