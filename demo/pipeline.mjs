// Pipeline bake-off: sequential vs streaming.
// Measures TIME TO FIRST AUDIO - the only latency the driver actually feels.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, chat, openaiTts } from './lib.mjs';

loadEnv();
const OUT = 'audio-cache';
fs.mkdirSync(OUT, { recursive: true });

const CAST = { narrator: 'onyx', mara: 'nova', dispatch: 'echo' };

const SYSTEM = `You write a voice-only driving story. Output JSONL: one JSON object per line, no array, no markdown.
Each line: {"voice":"<name>","text":"<spoken>","tone":"<direction>"} or {"voice":"sfx","name":"<id>"}.
Valid voices: ${Object.keys(CAST).join(', ')}, sfx.
RULE: the first line must be under 10 words.
Write exactly 5 lines. End with the narrator offering two choices.`;

const USER = 'The driver says: "I take the off-ramp."';

function parseLine(s) {
  try {
    const o = JSON.parse(s);
    return o.voice && (o.text || o.name) ? o : null;
  } catch {
    return null;
  }
}

// Reject any voice the cast does not have.
const valid = (o) => o.voice === 'sfx' || o.voice in CAST;

async function speak(o, idx) {
  if (o.voice === 'sfx') return { idx, sfx: o.name, bytes: 0 };
  const { buf } = await openaiTts(CAST[o.voice], o.text, o.tone);
  fs.writeFileSync(path.join(OUT, `turn-${idx}-${o.voice}.mp3`), buf);
  return { idx, voice: o.voice, bytes: buf.length };
}

async function sequential() {
  const t0 = performance.now();
  const raw = await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }]);
  const llmDone = performance.now() - t0;

  const lines = raw.split('\n').map(parseLine).filter((o) => o && valid(o));
  let firstAudio = 0;
  for (const [i, o] of lines.entries()) {
    await speak(o, i);
    if (!firstAudio) firstAudio = performance.now() - t0;
  }
  return { llmDone, firstAudio, all: performance.now() - t0, lines };
}

async function streaming() {
  const t0 = performance.now();
  let firstToken = 0;
  let firstAudio = 0;
  let buf = '';
  let idx = 0;
  const jobs = [];
  const lines = [];

  for await (const tok of await chat(
    [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }],
    { stream: true },
  )) {
    if (!firstToken) firstToken = performance.now() - t0;
    buf += tok;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const o = parseLine(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
      if (!o || !valid(o)) continue;
      lines.push(o);
      // fire TTS immediately; do NOT await - model keeps writing meanwhile
      jobs.push(
        speak(o, idx++).then((r) => {
          if (!firstAudio) firstAudio = performance.now() - t0;
          return r;
        }),
      );
    }
  }
  const trailing = parseLine(buf.trim());
  if (trailing && valid(trailing)) {
    lines.push(trailing);
    jobs.push(speak(trailing, idx++).then((r) => { if (!firstAudio) firstAudio = performance.now() - t0; return r; }));
  }

  await Promise.all(jobs);
  return { firstToken, firstAudio, all: performance.now() - t0, lines };
}

console.log(`\n  Driver says: "I take the off-ramp."\n`);

console.log('  running SEQUENTIAL ...');
const seq = await sequential();
console.log('  running STREAMING ...');
const str = await streaming();

console.log('\n  Script the model wrote:');
for (const o of str.lines) {
  console.log(`    ${(o.voice + ':').padEnd(10)} ${o.text ?? '[sfx: ' + o.name + ']'}`);
}

const ms = (n) => `${Math.round(n)}ms`;
console.log('\n  ' + 'APPROACH'.padEnd(16) + 'FIRST AUDIO'.padStart(13) + 'ALL AUDIO'.padStart(12));
console.log('  ' + '-'.repeat(41));
console.log('  ' + 'Sequential'.padEnd(16) + ms(seq.firstAudio).padStart(13) + ms(seq.all).padStart(12));
console.log('  ' + 'Streaming'.padEnd(16) + ms(str.firstAudio).padStart(13) + ms(str.all).padStart(12));

const saved = seq.firstAudio - str.firstAudio;
console.log(`\n  Driver waits ${ms(saved)} less  (${Math.round((saved / seq.firstAudio) * 100)}% faster to first sound)`);
console.log(`  [detail] sequential waited ${ms(seq.llmDone)} for the full script;`);
console.log(`           streaming started TTS after first token at ${ms(str.firstToken)}\n`);
