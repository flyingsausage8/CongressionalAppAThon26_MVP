// Does the engagement tracker actually notice a driver nodding off?
import { Session } from '../server/game.mjs';

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}  (got ${got})`);
};

const read = (replies) => {
  const s = new Session('the-quiet-door');
  s.replies = replies;
  return s.alertness();
};

const reply = (secs, words, urges = 0) => ({ ms: secs * 1000, words, urges });

console.log('\nno answers yet');
check('nothing to read', read([]), null);

console.log('\nwide awake: fast, wordy, never nudged');
const awake = read([reply(2, 8), reply(3, 6), reply(2.5, 9), reply(1.8, 5)]);
check('level', awake.level, 'awake');
check('average seconds', awake.secs, 2.3);

console.log('\nslowing down: longer pauses, shorter answers');
check('level', read([reply(5, 4), reply(6, 3), reply(5.5, 2)]).level, 'slowing');

console.log('\nfading: slow, one-word, needing nudges');
const fading = read([reply(9, 1), reply(11, 1, 1), reply(8, 2, 1), reply(12, 1, 2)]);
check('level', fading.level, 'fading');
check('counts the nudges', fading.nudged, 3);

console.log('\nonly one weak sign is not enough to call it');
check('slow but talkative and never nudged', read([reply(8, 9), reply(7.5, 11)]).level, 'slowing');
check('short but instant', read([reply(1.5, 1), reply(1.2, 1)]).level, 'slowing');

console.log('\nthe reading reaches the story');
const s = new Session('the-quiet-door');
s.replies = [reply(10, 1, 1), reply(12, 1, 2), reply(9, 1, 1)];
const note = s.direction(0);
check('director is told they are fading', note.includes('They are fading.'), true);
check('and told to wake them up', note.includes('Wake them up.'), true);
check('never mentions driving to the story', note.includes('Never mention being tired, driving'), true);

const awakeNote = (() => {
  const a = new Session('the-quiet-door');
  a.replies = [reply(2, 8), reply(2, 7)];
  return a.direction(0);
})();
check('an awake listener gets no wake-up order', awakeNote.includes('Wake them up.'), false);
check('but is still reported', awakeNote.includes('Awake and keeping up'), true);

console.log('\nthe plain-words line');
console.log(`  "${s.alertnessLine()}"`);

console.log(fails ? `\n${fails} FAILED` : '\nPASS - all alertness checks');
process.exit(fails ? 1 : 0);
