import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { loadEnv } from './env.mjs';
import { speechToken } from './ai.mjs';
import { Session } from './game.mjs';
import { storyMenu, getStory, defaultStoryId } from './stories.mjs';
import { Transcript, listSaves, loadSave } from './transcript.mjs';

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

  if (url.pathname === '/api/stories') {
    json(res, 200, { stories: storyMenu(), saves: listSaves(), default: defaultStoryId });
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
  let session = null;
  let log = null;
  let busy = false;

  const emit = (msg) => {
    if (log) {
      if (msg.t === 'line') log.line(msg);
      else if (msg.t === 'turnEnd') log.endTurn(msg);
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const run = async (opts) => {
    if (busy || !session) return;
    busy = true;
    if (log) {
      if (opts.said) log.said(opts.said);
      else if (opts.nudge) log.nudged();
    }
    emit({ t: 'thinking' });
    try {
      await session.takeTurn({ ...opts, emit });
      log?.save(session);
    } catch (err) {
      emit({ t: 'error', message: String(err.message || err) });
    } finally {
      busy = false;
    }
  };

  emit({ t: 'ready', stories: storyMenu(), saves: listSaves(), default: defaultStoryId });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.t === 'start') {
      if (busy) return;

      const snap = msg.resumeId ? loadSave(msg.resumeId) : null;
      if (snap) {
        session = Session.restore(snap);
        log = new Transcript(session.story, snap.id);
        console.log(`  -> continuing "${session.story.title}" from exchange ${session.turn}`);
        emit({
          t: 'storyStarted',
          id: session.story.id,
          title: session.story.title,
          you: session.story.you,
          goal: session.story.goal,
          saveId: log.id,
          resumed: true,
          turn: session.turn,
          recap: recapOf(snap),
        });
        run({ said: null, resumed: true });
        return;
      }

      const story = getStory(msg.storyId);
      session = new Session(story.id);
      log = new Transcript(story);
      console.log(`  -> ${story.title}  (transcript: ${path.relative(process.cwd(), log.md)})`);
      emit({ t: 'storyStarted', id: story.id, title: story.title, you: story.you, goal: story.goal, saveId: log.id });
      run({ said: null });
    } else if (msg.t === 'say' && msg.text?.trim()) {
      run({ said: msg.text.trim(), replyMs: Number(msg.replyMs) || 0, urges: Number(msg.urges) || 0 });
    } else if (msg.t === 'idle') {
      run({ nudge: Number(msg.level) || 1 });
    } else if (msg.t === 'mic') {
      const detail = String(msg.detail || '').slice(0, 300);
      console.log(`  [mic] ${msg.event}${detail ? ' - ' + detail : ''}`);
      log?.note(`${msg.event}${detail ? ' - ' + detail : ''}`);
    }
  });
});

/** Lines of the saved story, so a resumed session can show what came before. */
function recapOf(snap) {
  const out = [];
  for (const h of (snap.history || []).slice(-8)) {
    if (h.role === 'user') {
      out.push({ you: true, text: String(h.content).replace(/^You say: "?|"$/g, '') });
    } else {
      for (const raw of String(h.content).split('\n')) {
        try {
          const o = JSON.parse(raw);
          if (o.text) out.push({ voice: o.voice, as: o.as || null, text: o.text });
        } catch { /* skip */ }
      }
    }
  }
  return out;
}

server.listen(PORT, () => {
  console.log(`\n  Story engine running at  http://localhost:${PORT}`);
  console.log(`  Starting points: ${storyMenu().map((s) => s.id).join(', ')}\n`);
});
