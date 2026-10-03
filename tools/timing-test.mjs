// How long did the driver really take to answer?
//
// Replays the exact timings from transcripts/2026-10-03T19-17-31-the-last-egg.md, where a
// driver who answered promptly was recorded as taking 20.4 seconds and marked "slowing down".
// The arithmetic is lifted straight out of public/app.js so this cannot drift from it.

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

/** Pull a function out of the client verbatim, so the test runs the shipped code. */
function take(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} is gone from app.js - update this test`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`could not read ${name}`);
}

// The client banks thinking time whenever the story starts talking. Check that line is
// still there, then model it, so the test fails if the behaviour is removed.
if (!/driver\.thinkMs \+= Date\.now\(\) - driver\.windowStart/.test(src)) {
  throw new Error('app.js no longer banks thinking time when the story starts talking');
}

const driver = {};
const noteSpoke = new Function('driver', `${take('noteSpoke')}; return noteSpoke;`)(driver);

let now = 0;
const realNow = Date.now;
Date.now = () => now;

function question(at) {                      // a brand new question finished being spoken
  now = at;
  Object.assign(driver, { askedAt: at, thinkMs: 0, spokeAt: 0, replyMs: 0, windowStart: at });
}
function storyTalks(at) {                    // a nudge begins: the floor is not theirs
  now = at;
  driver.thinkMs += at - driver.windowStart;
  driver.windowStart = 0;
}
function windowReopens(at) { now = at; driver.windowStart = at; }
function speaks(at) { now = at; noteSpoke(); }

let failed = 0;
const check = (name, got, want) => {
  const ok = Math.abs(got - want) < 100;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${(got / 1000).toFixed(1)}s (wanted ${(want / 1000).toFixed(1)}s)`);
};

// --- the real transcript, to the second ------------------------------------------------
// 19:18:46 question finished, mic opened
// 19:18:51 nudge requested; the story then wrote and spoke it until 19:19:02
// 19:19:02 mic opened again
// 19:19:06 driver spoke
const T = (mmss) => (Number(mmss.split(':')[0]) * 60 + Number(mmss.split(':')[1])) * 1000;

question(T('18:46'));
storyTalks(T('18:51'));
windowReopens(T('19:02'));
speaks(T('19:06'));
check('nudged answer counts only the driver\u2019s own time', driver.replyMs, 9000);

// Same driver, no nudge: five seconds is five seconds.
question(T('20:00'));
speaks(T('20:05'));
check('a plain answer is unchanged', driver.replyMs, 5000);

// A genuinely slow driver is still reported as slow.
question(T('21:00'));
storyTalks(T('21:05'));
windowReopens(T('21:16'));
speaks(T('21:30'));
check('a genuinely slow driver still reads slow', driver.replyMs, 19000);

// Talking for a long time does not count against them: the clock stops at the first word.
question(T('22:00'));
speaks(T('22:02'));
now = T('22:20');
noteSpoke();                                  // later words must not move the reading
check('a long, chatty answer is not penalised', driver.replyMs, 2000);

Date.now = realNow;

// The old arithmetic, for contrast: wall clock from question to first word.
const old = T('19:06') - T('18:46');
console.log(`\nbefore: ${(old / 1000).toFixed(1)}s reported for that nudged answer`);
console.log(`after:  9.0s - the 11s the story spent talking is no longer blamed on the driver`);

if (failed) { console.error(`\nFAIL - ${failed} check(s)`); process.exit(1); }
console.log('\nPASS - all reply-timing checks');
