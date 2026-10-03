// Runs several turns in a row - the case that was broken.
// Checks every turn restarts at idx 0, produces audio, and ends cleanly.
import { WebSocket } from 'ws';

const REPLIES = [
  'I stay on the path. Who are you, exactly?',
  'Sure, you can walk with me. But I am not telling you where I am going.',
  'Those flowers do look nice. Maybe just a few for Grandma.',
  'Wait, why are you running off all of a sudden?',
  'I knock on the door and call out for Grandma.',
  'Grandma, what big eyes you have! And why are you wearing her glasses upside down?',
  'I think the woodcutter is right outside. Should I call him in?',
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
      `  ${String(n).padStart(2)}/${m.total}  ${String(m.act || '').padEnd(20)} ${cur.lines.length} lines | ` +
      `audio ${cur.audio}/${speech} | ${String(m.firstAudioMs).padStart(4)}ms | ${voices}  ${ok ? 'ok' : 'FAIL'}` +
      (m.done ? '   <- THE END' : ''),
    );
    turns.push({ ...cur, ok, total: m.idx });

    if (m.done) {
      clearTimeout(timeout);
      const bad = turns.filter((t) => !t.ok).length;
      const allVoices = new Set(turns.flatMap((t) => t.lines.map((l) => l.voice)));
      console.log(`\n  story ended after ${turns.length} exchanges, ${bad} failed`);
      console.log(`  voices used: ${[...allVoices].join(', ')}\n`);
      ws.close();
      process.exit(bad ? 1 : 0);
    }

    startTurn();
    ws.send(JSON.stringify({ t: 'say', text: REPLIES[(turns.length - 1) % REPLIES.length] }));
  }
});

ws.on('error', (e) => {
  console.error('  socket error:', e.message);
  process.exit(1);
});
