// End-to-end check: opens a real websocket, runs the opening turn and one reply.
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:3000/ws');
let turn = 0;
const seen = [];

const timeout = setTimeout(() => {
  console.error('\n  TIMEOUT - no turnEnd received\n');
  process.exit(1);
}, 90000);

ws.on('open', () => console.log('  connected'));

ws.on('message', (raw) => {
  const m = JSON.parse(raw);

  if (m.t === 'ready') {
    console.log(`  ready: ${m.title}\n  --- opening turn ---`);
    ws.send(JSON.stringify({ t: 'start' }));
  } else if (m.t === 'line') {
    const txt = m.voice === 'sfx' ? `[${m.name}]` : m.text;
    console.log(`  ${String(m.idx).padStart(2)}  ${(m.voice + ':').padEnd(10)} ${txt}`);
    if (m.tone) console.log(`      ${' '.repeat(10)} tone: ${m.tone}`);
    seen.push(m);
  } else if (m.t === 'audio') {
    const kb = Math.round((m.mp3.length * 0.75) / 1024);
    console.log(`      ${' '.repeat(10)} audio ready, ${kb}KB`);
  } else if (m.t === 'audioError') {
    console.log(`  !! audio error idx ${m.idx}: ${m.message}`);
  } else if (m.t === 'error') {
    console.error(`  !! ${m.message}`);
    process.exit(1);
  } else if (m.t === 'turnEnd') {
    console.log(`  >> ${m.idx} lines | first audio ${m.firstAudioMs}ms | total ${m.totalMs}ms\n`);
    turn++;
    if (turn === 1) {
      console.log('  --- driver replies ---');
      ws.send(JSON.stringify({ t: 'say', text: 'I stay on the main road. Who is this on channel nine?' }));
    } else {
      clearTimeout(timeout);
      const voices = new Set(seen.map((s) => s.voice));
      console.log(`  PASS - ${seen.length} lines across voices: ${[...voices].join(', ')}\n`);
      ws.close();
      process.exit(0);
    }
  }
});

ws.on('error', (e) => {
  console.error('  socket error:', e.message);
  process.exit(1);
});
