// Proves a dropped connection resumes the same story instead of dying silently.
import WebSocket from 'ws';

const URL = 'ws://localhost:3000/ws';

function session(resumeId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const lines = [];
    let saveId = null;
    let started = null;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'storyStarted') { saveId = m.saveId; started = m; }
      if (m.t === 'line') lines.push(m);
      if (m.t === 'turnEnd') resolve({ ws, saveId, started, lines, end: m });
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'start', storyId: 'the-last-egg', resumeId })));
    ws.on('error', reject);
  });
}

function answer(ws, text) {
  return new Promise((resolve) => {
    const lines = [];
    const h = (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'line') lines.push(m);
      if (m.t === 'turnEnd') { ws.off('message', h); resolve({ lines, end: m }); }
    };
    ws.on('message', h);
    ws.send(JSON.stringify({ t: 'say', text }));
  });
}

let fails = 0;
const check = (label, ok, extra = '') => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

const a = await session(null);
console.log(`\nstarted  -> exchange ${a.end.turn}, saveId ${a.saveId}`);
check('server hands back a save id', !!a.saveId);

const t2 = await answer(a.ws, 'take the gate');
console.log(`answered -> exchange ${t2.end.turn}`);
const scene = t2.end.state.scene;

console.log('\n-- yanking the connection --');
a.ws.terminate();
await new Promise((r) => setTimeout(r, 700));

const b = await session(a.saveId);
console.log(`\nreconnected -> exchange ${b.end.turn}, resumed ${b.started.resumed}`);
for (const l of b.lines.slice(0, 3)) console.log(`  ${l.voice}: ${l.text}`);

check('it resumed rather than restarted', b.started.resumed === true);
check('it carried on from where we were', b.end.turn > t2.end.turn, `${t2.end.turn} -> ${b.end.turn}`);
check('it wrote to the same save', b.saveId === a.saveId);
check('it kept the scene', !!b.end.state.scene, `"${scene}" -> "${b.end.state.scene}"`);
check('it remembered the cast', Object.keys(b.end.state.cast || {}).length >= 3);
check('it offered a recap', Array.isArray(b.started.recap) && b.started.recap.length > 0,
  `${b.started.recap?.length} lines`);

b.ws.close();
console.log(fails ? `\n${fails} FAILED` : '\nPASS - a dropped connection resumes the same story');
process.exit(fails ? 1 : 0);
