// Voice bake-off: Azure Speech vs OpenAI gpt-4o-mini-tts.
// Same line, five treatments. Writes mp3s to audio-cache/ and prints latency.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, azureSpeech, openaiTts } from './lib.mjs';

loadEnv();
const OUT = 'audio-cache';
fs.mkdirSync(OUT, { recursive: true });

const LINE = 'You missed the off-ramp. On purpose?';
const TONE = 'Suspicious and quiet, half-smiling. Like she already knows the answer.';

const TESTS = [
  ['Azure Speech | Nova, plain', '1-azure-nova.mp3', () =>
    azureSpeech('en-US-NovaTurboMultilingualNeural', LINE)],

  ['Azure Speech | Ava, whisper style', '2-azure-ava-whisper.mp3', () =>
    azureSpeech('en-US-AvaMultilingualNeural',
      `<mstts:express-as style="whispering"><prosody rate="-8%">${LINE}</prosody></mstts:express-as>`)],

  ['OpenAI TTS   | nova, plain', '3-openai-nova-plain.mp3', () =>
    openaiTts('nova', LINE, null)],

  ['OpenAI TTS   | nova, ACTED', '4-openai-nova-acted.mp3', () =>
    openaiTts('nova', LINE, TONE)],

  ['OpenAI TTS   | onyx, narrator', '5-openai-onyx-narrator.mp3', () =>
    openaiTts('onyx', 'The off-ramp slides past in the dark.',
      'Calm, dry narrator. Low and steady. Unhurried.')],
];

console.log(`\n  Line: "${LINE}"`);
console.log(`  Tone: ${TONE}\n`);

const rows = [];
for (const [label, file, fn] of TESTS) {
  const t0 = performance.now();
  const { buf, firstByteAt } = await fn();
  fs.writeFileSync(path.join(OUT, file), buf);
  rows.push({ label, file, first: Math.round(firstByteAt - t0), total: Math.round(performance.now() - t0), kb: Math.round(buf.length / 1024) });
  console.log(`  ok  ${file}`);
}

console.log('\n  ' + 'TREATMENT'.padEnd(36) + 'FIRST'.padStart(7) + 'TOTAL'.padStart(8) + 'SIZE'.padStart(7));
console.log('  ' + '-'.repeat(58));
for (const r of rows) {
  console.log('  ' + r.label.padEnd(36) + `${r.first}ms`.padStart(7) + `${r.total}ms`.padStart(8) + `${r.kb}KB`.padStart(7));
}
console.log(`\n  Audio written to ${path.resolve(OUT)}\n`);
