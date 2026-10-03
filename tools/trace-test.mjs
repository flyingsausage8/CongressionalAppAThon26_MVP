// Does the on-screen trace actually cover every decision driver mode makes?
import { readFileSync } from 'node:fs';

const u = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const js = u('../public/app.js');
const html = u('../public/index.html');
const css = u('../public/style.css');

const checks = [
  ['panel markup', html.includes('id="trace"') && html.includes('id="traceClear"')],
  // The kind classes must stay namespaced: a bare `.mic` collides with the talk button.
  ['panel styles', /\.trace \.tr\.t-story/.test(css) && !/\.trace \.tr\.story/.test(css)],
  ['css stays ascii', /^[\x00-\x7F]*$/.test(css)],
  ['element refs', js.includes("trace: $('trace')")],
  ['shown only in driver mode', /if \(driver\.on\) \{ trace\.show\(\)/.test(js)],
  ['audio finished playing', js.includes('audio finished - waiting')],
  ['recording window opens', js.includes('RECORDING - ')],
  ['your voice heard', js.includes('HEARD YOU START')],
  ['answer sent', js.includes('SENT: ')],
  ['answer ignored, with reason', js.includes('IGNORED (story talking)') && js.includes('IGNORED (just a noise)')],
  ['nudge requested', js.includes('NUDGE #')],
  ['nudge held back for your voice', js.includes('nudge held back')],
  ['next script being written', js.includes('WRITING THE NEXT SCRIPT')],
  ['each line as it speaks', js.includes('speaking line ')],
  ['microphone lifecycle', js.includes('TRACE_MIC')],
  ['clock restarts at each question', /mark\(what\) \{\s*this\.t0 = Date\.now\(\)/.test(js)],
  ['trace is capped so it cannot grow forever', js.includes('ui.trace.children.length > 300')],
  ['text is inserted safely, not as html', js.includes('row.lastChild.textContent = what')],
];

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}
if (bad) { console.error(`\nFAIL - ${bad} missing`); process.exit(1); }
console.log('\nPASS - the trace covers every step');
