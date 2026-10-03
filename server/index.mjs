import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { loadEnv } from './env.mjs';
import { speechToken } from './ai.mjs';
import { Session, castInfo, storyInfo } from './game.mjs';

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.resolve('public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/speech-token') {
    try {
      json(res, 200, await speechToken());
    } catch (err) {
      json(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url.pathname === '/api/cast') {
    json(res, 200, { cast: castInfo, story: { title: storyInfo.title, premise: storyInfo.premise } });
    return;
  }

  // static files, confined to public/
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const session = new Session();
  let busy = false;

  const emit = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const run = async (opts) => {
    if (busy) return;
    busy = true;
    emit({ t: 'thinking' });
    try {
      await session.takeTurn({ ...opts, emit });
    } catch (err) {
      emit({ t: 'error', message: String(err.message || err) });
    } finally {
      busy = false;
    }
  };

  emit({ t: 'ready', title: storyInfo.title });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === 'start') run({ said: null });
    else if (msg.t === 'say' && msg.text?.trim()) run({ said: msg.text.trim() });
    else if (msg.t === 'idle') run({ nudge: true });
  });
});

server.listen(PORT, () => {
  console.log(`\n  ${storyInfo.title} running at  http://localhost:${PORT}\n`);
});
