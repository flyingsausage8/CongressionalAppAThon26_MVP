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
  '\nreturn { isRealAnswer, isCommand, isEcho, STOP_WORDS, GO_WORDS };';

const queue = { paused: false, nowText: '' };
const { isRealAnswer, isCommand, isEcho, STOP_WORDS, GO_WORDS } =
  new Function('queue', block)(queue);

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

console.log(fails ? `\n${fails} FAILED` : '\nPASS - all driver-mode checks');
process.exit(fails ? 1 : 0);
