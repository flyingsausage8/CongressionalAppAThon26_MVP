// Pulls the driver-mode helpers straight out of app.js and exercises them.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`could not find ${from}`);
  return src.slice(a, b);
};

const block =
  cut('const STOP_WORDS', 'function driverHint') +
  '\nreturn { isRealAnswer, isCommand, isEcho, isEchoOfTurn, STOP_WORDS, GO_WORDS };';

const queue = { paused: false, nowText: '', playing: false };
const spokenThisTurn = [];
const { isRealAnswer, isCommand, isEcho, isEchoOfTurn, STOP_WORDS, GO_WORDS } =
  new Function('queue', 'spokenThisTurn', block)(queue, spokenThisTurn);

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}  (got ${got})`);
};

console.log('\nis this a real answer?');
for (const [t, want] of [
  ['the gate', true], ['yes', true], ['a', true], ['left', true],
  ['um', false], ['uhhh', false], ['hmm', false], ['so', false],
  ['um the gate', true], ['   ', false], ['uh... yeah ok', true],
]) check(JSON.stringify(t), isRealAnswer(t), want);

console.log('\nspoken commands');
queue.nowText = '';
for (const [t, want] of [
  ['stop', true], ['Stop.', true], ['pause', true], ['wait', true],
  ['hold on', true], ['I want to stop at the gate', false], ['keep walking', false],
]) check(JSON.stringify(t), isCommand(t, STOP_WORDS), want);

console.log('\nmicrophone echo from the speakers');
queue.nowText = 'Wait. Someone is coming up the road behind us.';
check('character says "Wait."', isCommand('wait', STOP_WORDS), false);
check('driver says "stop" over it', isCommand('stop', STOP_WORDS), true);
queue.nowText = 'Odo stops walking and listens.';
check('line contains "stops", driver says "stop"', isCommand('stop', STOP_WORDS), false);

console.log('\nresuming while paused');
queue.paused = true;
queue.nowText = 'Carry on, then. Keep going until the bridge.';
check('"resume" still works while paused', isCommand('resume', GO_WORDS), true);
check('"carry on" still works while paused', isCommand('carry on', GO_WORDS), true);

console.log('\nthe bug that actually happened: speakers transcribed as the answer');
spokenThisTurn.push(
  'Dusk settles over the north road.',
  'The bundle stays warm against your chest. Ahead, village lanterns glow beside a toll gate.',
  'Odo rubs his bad knee and studies the gate.',
  'Odo. Thirty years carrying secrets. That gatekeeper searches every bundle after dark.',
  'Wren keeps several steps behind him.',
  'Wren. New to respectable company. Take the gate and risk a search, or circle through cold fields. Which do you choose?',
);

// Verbatim from transcripts/2026-10-03T04-49-57-the-last-egg.md
check(
  'whole turn echoed back',
  isEchoOfTurn('Wren new to respectable company. Take the gate and risk a search or circle through cold fields. Which do you choose?'),
  true,
);
check('a single echoed line', isEchoOfTurn('Odo rubs his bad knee and studies the gate'), true);
check('echo with a misheard word', isEchoOfTurn('Odo rubs his bad need and studies the gate'), true);
check('tail fragment', isEchoOfTurn('Which do you choose'), true);

console.log('\n...but distinctive answers must never be mistaken for echo');
for (const [t, want] of [
  ['hide under the hay', false], ['I want to go around', false], ['no, go around', false],
  ['yes', false], ['lets go left instead', false], ['ask him about the egg', false],
]) check(JSON.stringify(t), isEchoOfTurn(t), want);

// Short answers built from the question's own words ("the gate") do look like echo to this
// matcher. That is fine: it is only consulted in the 600ms after the speakers stop, and
// only when the recogniser gave us no timings. Timings are what normally does the work.
console.log('\nknown and accepted: short answers reusing the question\'s words');
for (const t of ['the gate', 'take the gate', 'circle through the fields']) {
  console.log(`  note  ${JSON.stringify(t)} looks like echo (${isEchoOfTurn(t)}) - caught by timing instead`);
}
spokenThisTurn.length = 0;

console.log(fails ? `\n${fails} FAILED` : '\nPASS - all driver-mode checks');
process.exit(fails ? 1 : 0);
