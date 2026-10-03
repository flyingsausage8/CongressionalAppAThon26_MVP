// Builds audio-cache/listen.html - a browser page to A/B the voice samples.
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'audio-cache';

const GROUPS = [
  {
    title: 'Azure Speech',
    note: 'Faster, 953 voices, but limited acting control.',
    items: [
      ['1-azure-nova.mp3', 'Nova — plain', '322ms'],
      ['2-azure-ava-whisper.mp3', 'Ava — SSML whispering style', '422ms'],
    ],
  },
  {
    title: 'OpenAI gpt-4o-mini-tts',
    note: 'Slightly slower, 11 voices, but takes plain-English acting direction.',
    items: [
      ['3-openai-nova-plain.mp3', 'nova — NO direction', '479ms'],
      ['4-openai-nova-acted.mp3', 'nova — "suspicious, quiet, half-smiling"', '544ms'],
      ['5-openai-onyx-narrator.mp3', 'onyx — "calm, dry narrator"', '291ms'],
    ],
  },
];

const turns = fs
  .readdirSync(OUT)
  .filter((f) => f.startsWith('turn-'))
  .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));

const row = ([file, label, ms]) =>
  fs.existsSync(path.join(OUT, file))
    ? `<div class="row"><div class="meta"><span class="lbl">${label}</span><span class="ms">${ms}</span></div><audio controls preload="none" src="${file}"></audio></div>`
    : '';

const html = `<!doctype html>
<meta charset="utf-8"><title>Driving Game — voice test</title>
<style>
 body{background:#111;color:#eee;font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px}
 h1{font-size:20px;margin:0 0 4px}
 .line{color:#8ab4f8;font-size:17px;margin:0 0 28px}
 h2{font-size:15px;margin:30px 0 2px;color:#fff}
 .note{color:#888;font-size:13px;margin:0 0 12px}
 .row{display:flex;align-items:center;gap:16px;padding:9px 0;border-bottom:1px solid #222}
 .meta{flex:1;min-width:0}
 .lbl{display:block}
 .ms{color:#666;font-size:12px}
 audio{height:34px;flex-shrink:0}
 .hl{background:#1b2a1b;border-left:3px solid #4caf50;padding-left:12px}
 .tip{background:#1a1a22;border-left:3px solid #8ab4f8;padding:12px 16px;margin:24px 0;font-size:14px}
</style>
<h1>Driving Game — voice test</h1>
<p class="line">“You missed the off-ramp. On purpose?”</p>

<div class="tip"><b>Compare #3 and #4.</b> Same voice, same words. #3 gets no direction; #4 is told
“suspicious and quiet, half-smiling — like she already knows the answer.”</div>

${GROUPS.map(
  (g) => `<h2>${g.title}</h2><p class="note">${g.note}</p>${g.items.map(row).join('')}`,
).join('')}

${
  turns.length
    ? `<h2>Full generated turn (streaming pipeline)</h2>
<p class="note">The model wrote this live after the driver said “I take the off-ramp.” First audio in 847ms.</p>
${turns
  .map(
    (f) =>
      `<div class="row"><div class="meta"><span class="lbl">${f.replace(/^turn-\d+-/, '').replace('.mp3', '')}</span><span class="ms">${f}</span></div><audio controls preload="none" src="${f}"></audio></div>`,
  )
  .join('')}`
    : ''
}
`;

fs.writeFileSync(path.join(OUT, 'listen.html'), html);
console.log('wrote ' + path.resolve(OUT, 'listen.html'));
