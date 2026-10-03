// Checks that an urge re-asks the question without spending an exchange.
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000/ws');
const turns = [];
let lines = [];

const wait = () =>
  new Promise((res) => {
    const h = (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'line') lines.push(m);
      if (m.t === 'turnEnd') {
        ws.off('message', h);
        res(m);
      }
    };
    ws.on('message', h);
  });

ws.on('open', async () => {
  const opening = wait();
  ws.send(JSON.stringify({ t: 'start', storyId: 'the-last-egg' }));
  let end = await opening;
  turns.push({ what: 'opening', turn: end.turn, lines: lines.length });
  console.log(`opening   -> exchange ${end.turn}, ${lines.length} lines`);
  console.log(`  last: ${lines.at(-1).voice}: ${lines.at(-1).text}`);

  for (const level of [1, 2]) {
    lines = [];
    const p = wait();
    ws.send(JSON.stringify({ t: 'idle', level }));
    end = await p;
    turns.push({ what: `urge ${level}`, turn: end.turn, lines: lines.length });
    console.log(`\nurge ${level}    -> exchange ${end.turn}, ${lines.length} lines`);
    for (const l of lines) console.log(`  ${l.voice}: ${l.text}`);
  }

  const spent = turns.at(-1).turn !== turns[0].turn;
  console.log(`\n${spent ? 'FAIL - urges ate the budget' : 'PASS - urges cost no exchanges'}`);
  const brief = turns.slice(1).every((t) => t.lines <= 4);
  console.log(brief ? 'PASS - urges stayed short' : 'FAIL - urge was too long');
  ws.close();
  process.exit(spent || !brief ? 1 : 0);
});
