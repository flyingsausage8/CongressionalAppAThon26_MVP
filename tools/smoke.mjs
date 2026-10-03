// End-to-end check: opens a real websocket, runs the opening turn and one reply.
//   node tools/smoke.mjs [story-id]
import { WebSocket } from 'ws';

const STORY = process.argv[2] || null;
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
    const ids = m.stories.map((s) => s.id);
    const pick = STORY && ids.includes(STORY) ? STORY : m.default;
    console.log(`  stories: ${ids.join(', ')}\n  running: ${pick}\n  --- opening turn ---`);
    ws.send(JSON.stringify({ t: 'start', storyId: pick }));
  } else if (m.t === 'storyStarted') {
    console.log(`  "${m.title}"\n`);
  } else if (m.t === 'line') {
    console.log(`  ${String(m.idx).padStart(2)}  ${((m.as || m.voice) + ':').padEnd(12)} ${m.text}`);
    if (m.tone) console.log(`      ${' '.repeat(12)} tone: ${m.tone}`);
    seen.push(m);
  } else if (m.t === 'audio') {
    const kb = Math.round((m.mp3.length * 0.75) / 1024);
    console.log(`      ${' '.repeat(12)} audio ready, ${kb}KB`);
  } else if (m.t === 'audioError') {
    console.log(`  !! audio error idx ${m.idx}: ${m.message}`);
  } else if (m.t === 'error') {
    console.error(`  !! ${m.message}`);
    process.exit(1);
  } else if (m.t === 'turnEnd') {
    console.log(`  >> ${m.idx} lines | first audio ${m.firstAudioMs}ms | total ${m.totalMs}ms`);
    console.log(`  >> scene: ${m.state.scene}`);
    for (const [k, v] of Object.entries(m.state.cast || {})) {
      if (v.condition && m.state.seen.includes(k)) console.log(`     ${(v.name || k).padEnd(14)} ${v.condition}`);
    }
    console.log('');
    turn++;
    if (turn === 1) {
      console.log('  --- you reply ---');
      ws.send(JSON.stringify({ t: 'say', text: 'Hold on. Who are you, and what exactly am I carrying?' }));
    } else {
      clearTimeout(timeout);
      const voices = new Set(seen.map((s) => s.as || s.voice));
      console.log(`  PASS - ${seen.length} lines across: ${[...voices].join(', ')}\n`);
      ws.close();
      process.exit(0);
    }
  }
});

ws.on('error', (e) => {
  console.error('  socket error:', e.message);
  process.exit(1);
});
