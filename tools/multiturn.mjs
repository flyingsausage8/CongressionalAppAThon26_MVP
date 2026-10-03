// Runs several turns in a row - the case that was broken.
// Checks every turn restarts at idx 0, produces audio, and ends cleanly.
import { WebSocket } from 'ws';

const REPLIES = [
  'I stay on the main road. Who is this on channel nine?',
  'Hunter, you still there? That guy keeps telling me to take the shortcut.',
  'Grandma, you sound different tonight. Did you leave the porch light on like always?',
];

const ws = new WebSocket('ws://localhost:3000/ws');
const turns = [];
let cur = null;

const timeout = setTimeout(() => {
  console.error('\n  TIMEOUT\n');
  process.exit(1);
}, 180000);

const startTurn = () => { cur = { lines: [], audio: 0, idxs: [] }; };

ws.on('open', () => startTurn());

ws.on('message', (raw) => {
  const m = JSON.parse(raw);

  if (m.t === 'ready') {
    ws.send(JSON.stringify({ t: 'start' }));
  } else if (m.t === 'line') {
    cur.lines.push(m);
    cur.idxs.push(m.idx);
  } else if (m.t === 'audio') {
    cur.audio++;
  } else if (m.t === 'error') {
    console.error('  server error:', m.message);
    process.exit(1);
  } else if (m.t === 'turnEnd') {
    const n = turns.length + 1;
    const speech = cur.lines.filter((l) => l.voice !== 'sfx').length;
    const ordered = cur.idxs.every((v, i) => v === i);
    const voices = [...new Set(cur.lines.map((l) => l.voice))].join(', ');

    const ok = cur.lines.length > 0 && ordered && cur.audio === speech;
    console.log(
      `  turn ${n}: ${String(cur.lines.length).padStart(2)} lines | idx 0..${m.idx - 1} ${ordered ? 'ok' : 'OUT OF ORDER'} | ` +
      `audio ${cur.audio}/${speech} | ${m.firstAudioMs}ms first | ${voices}  ${ok ? 'PASS' : 'FAIL'}`,
    );
    turns.push({ ...cur, ok, total: m.idx });

    if (turns.length <= REPLIES.length) {
      startTurn();
      ws.send(JSON.stringify({ t: 'say', text: REPLIES[turns.length - 1] }));
    } else {
      clearTimeout(timeout);
      const bad = turns.filter((t) => !t.ok).length;
      console.log(`\n  ${turns.length} turns, ${bad} failed\n`);
      ws.close();
      process.exit(bad ? 1 : 0);
    }
  }
});

ws.on('error', (e) => {
  console.error('  socket error:', e.message);
  process.exit(1);
});
