// Plays a whole story end to end against the live server.
//   node tools/play.mjs                 -> default story
//   node tools/play.mjs the-quiet-door  -> a specific starting point
//
// Checks: every turn restarts at idx 0, every spoken line gets audio,
// conditions persist rather than being rewritten every turn, and the story ends.
import { WebSocket } from 'ws';

const STORY = process.argv[2] || null;

// Deliberately generic so the same replies work for any starting point.
const REPLIES = [
  'Hold on. Who are you, and what exactly am I carrying?',
  'I want to keep going, but tell me what the risk is first.',
  'Fine. We do it your way, but I am not letting this out of my sight.',
  'I say no. There has to be another road.',
  'I ask the stranger what they actually want from us.',
  'I trust you on this one. Lead the way.',
  'Something is wrong here. I stop and say so out loud.',
  'I tell them the truth, all of it, and see what happens.',
  'We rest. Everyone is worn out and I say we stop for the night.',
  'I go first. If it goes badly, it goes badly on me.',
  'I ask what happens if we just walk away right now.',
  'I push forward. We finish this.',
];

const ws = new WebSocket('ws://localhost:3000/ws');
const turns = [];
let cur = null;
let prevConds = {};
let started = null;

const timeout = setTimeout(() => {
  console.error('\n  TIMEOUT\n');
  process.exit(1);
}, 420000);

const startTurn = () => { cur = { lines: [], audio: 0, idxs: [] }; };

ws.on('open', startTurn);

ws.on('message', (raw) => {
  const m = JSON.parse(raw);

  if (m.t === 'ready') {
    const ids = m.stories.map((s) => s.id);
    const pick = STORY && ids.includes(STORY) ? STORY : m.default;
    if (STORY && !ids.includes(STORY)) {
      console.error(`  unknown story "${STORY}". available: ${ids.join(', ')}`);
      process.exit(1);
    }
    ws.send(JSON.stringify({ t: 'start', storyId: pick }));
    return;
  }

  if (m.t === 'storyStarted') {
    started = Date.now();
    console.log(`\n  ${m.title}\n  ${m.goal}\n`);
    return;
  }

  if (m.t === 'line') {
    cur.lines.push(m);
    cur.idxs.push(m.idx);
  } else if (m.t === 'audio') {
    cur.audio++;
  } else if (m.t === 'error') {
    console.error('  server error:', m.message);
    process.exit(1);
  } else if (m.t === 'turnEnd') {
    const n = turns.length + 1;
    const ordered = cur.idxs.every((v, i) => v === i);
    const voices = [...new Set(cur.lines.map((l) => l.as || l.voice))];
    const words = cur.lines.reduce((a, l) => a + l.text.split(/\s+/).length, 0);
    const longest = Math.max(0, ...cur.lines.map((l) => l.text.split(/\s+/).length));

    // how many conditions the model rewrote this turn
    const conds = Object.fromEntries(
      Object.entries(m.state.cast || {}).map(([k, v]) => [k, v.condition]),
    );
    const changed = Object.keys(conds).filter((k) => conds[k] !== prevConds[k]).length;
    prevConds = conds;

    const ok = cur.lines.length > 0 && ordered && cur.audio === cur.lines.length;
    console.log(
      `  ${String(n).padStart(2)}  ${cur.lines.length} lines ${String(words).padStart(3)}w ` +
      `(max ${String(longest).padStart(2)}) | audio ${cur.audio}/${cur.lines.length} | ` +
      `${String(m.firstAudioMs).padStart(4)}ms | cond Δ${changed} | ${voices.join(', ')}  ${ok ? 'ok' : 'FAIL'}` +
      (m.done ? '   <- THE END' : ''),
    );
    turns.push({ ...cur, ok });

    if (m.done) {
      clearTimeout(timeout);
      const bad = turns.filter((t) => !t.ok).length;
      const cast = new Set(turns.flatMap((t) => t.lines.map((l) => l.as || l.voice)));
      console.log(`\n  ended after ${turns.length} exchanges in ${Math.round((Date.now() - started) / 1000)}s of model+TTS time`);
      console.log(`  failures: ${bad}`);
      console.log(`  cast heard: ${[...cast].join(', ')}`);
      console.log('\n  final conditions:');
      for (const [k, v] of Object.entries(m.state.cast || {})) if (v.condition) console.log(`    ${v.name || k}: ${v.condition}`);
      console.log(`    you: ${m.state.you}`);
      if (m.state.learned?.length) {
        console.log('\n  established:');
        for (const f of m.state.learned) console.log(`    - ${f}`);
      }
      console.log('');
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
