const $ = (id) => document.getElementById(id);

const ui = {
  startCard: $('startCard'), startBtn: $('startBtn'), premise: $('premise'),
  game: $('game'), script: $('script'), status: $('status'), dot: $('dot'),
  latency: $('latency'), heard: $('heardText'), micBtn: $('micBtn'),
  form: $('typeForm'), input: $('typeInput'),
};

const SFX_NAMES = ['turn_signal', 'radio_static', 'engine_rumble', 'rumble_strip', 'thunder', 'horn_distant'];
const IDLE_MS = 14000;

let ws, speechCfg, recognizer, listening = false, idleTimer = null;
const sfxCache = new Map();

function setStatus(text, cls = '') {
  ui.status.textContent = text;
  ui.dot.className = 'dot ' + cls;
}

/* ---------------- playback queue: TTS runs in parallel, audio plays in order ------------- */

const queue = {
  items: new Map(),   // idx -> { kind, src }
  next: 0,            // index we are waiting to play
  playing: false,

  add(idx, item) {
    this.items.set(idx, item);
    this.pump();
  },

  async pump() {
    if (this.playing) return;
    const item = this.items.get(this.next);
    if (!item) return;
    this.playing = true;
    this.items.delete(this.next);

    markLine(this.next, 'playing');
    try {
      if (item.kind === 'skip') {
        // nothing to play, just move on
      } else {
        await playAudio(item.src);
      }
    } catch (err) {
      console.warn('playback failed', err);
    }
    markLine(this.next, 'done');

    this.next++;
    this.playing = false;
    this.pump();

    if (!this.items.size) armIdle();
  },

  reset() {
    this.items.clear();
    this.next = 0;
    this.playing = false;
  },
};

function playAudio(src) {
  return new Promise((resolve) => {
    const a = new Audio(src);
    a.onended = resolve;
    a.onerror = resolve;
    a.play().catch(resolve);
  });
}

/* ---------------- script rendering ---------------- */

function addLine(idx, line) {
  const el = document.createElement('div');
  el.className = 'ln' + (line.voice === 'sfx' ? ' sfxline' : '');
  el.dataset.idx = idx;
  if (line.voice === 'sfx') {
    el.textContent = `[ ${line.name.replace(/_/g, ' ')} ]`;
  } else {
    const tone = line.tone ? ` <span class="tone">(${esc(line.tone)})</span>` : '';
    el.innerHTML = `<span class="who">${esc(line.voice)}</span>${esc(line.text)}${tone}`;
  }
  ui.script.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function markLine(idx, cls) {
  const el = ui.script.querySelector(`.ln[data-idx="${idx}"]`);
  if (el) el.classList.add(cls);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- idle nudge: the whole point of the game ---------------- */

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      setStatus('you went quiet…', 'think');
      ws.send(JSON.stringify({ t: 'idle' }));
    }
  }, IDLE_MS);
}

function cancelIdle() {
  clearTimeout(idleTimer);
}

/* ---------------- server connection ---------------- */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    setStatus('connected', 'live');
    ws.send(JSON.stringify({ t: 'start' }));
  };

  ws.onclose = () => setStatus('disconnected', 'err');
  ws.onerror = () => setStatus('connection error', 'err');

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);

    if (m.t === 'thinking') {
      cancelIdle();
      queue.reset();
      setStatus('writing…', 'think');
    } else if (m.t === 'line') {
      addLine(m.idx, m);
    } else if (m.t === 'audio') {
      const bytes = Uint8Array.from(atob(m.mp3), (c) => c.charCodeAt(0));
      queue.add(m.idx, { kind: 'audio', src: URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })) });
      setStatus('playing', 'live');
    } else if (m.t === 'sfx') {
      queue.add(m.idx, { kind: 'audio', src: sfxCache.get(m.name) || `sfx/${m.name}.wav` });
    } else if (m.t === 'audioError') {
      queue.add(m.idx, { kind: 'skip' });
    } else if (m.t === 'turnEnd') {
      ui.latency.textContent = m.firstAudioMs ? `first audio ${m.firstAudioMs}ms` : '';
      setStatus('your move', 'live');
      armIdle();
    } else if (m.t === 'error') {
      setStatus('error: ' + m.message, 'err');
    }
  };
}

function say(text) {
  if (!text?.trim() || ws?.readyState !== WebSocket.OPEN) return;
  cancelIdle();
  ui.heard.textContent = text;
  ws.send(JSON.stringify({ t: 'say', text }));
}

/* ---------------- speech to text ---------------- */

async function initSpeech() {
  const res = await fetch('/api/speech-token');
  if (!res.ok) throw new Error('could not get speech token');
  const { token, region } = await res.json();
  const SDK = window.SpeechSDK;
  speechCfg = SDK.SpeechConfig.fromAuthorizationToken(token, region);
  speechCfg.speechRecognitionLanguage = 'en-US';
  // refresh before the 10-minute token expires
  setInterval(async () => {
    try {
      const r = await fetch('/api/speech-token');
      if (r.ok) speechCfg.authorizationToken = (await r.json()).token;
    } catch { /* keep the old token and hope */ }
  }, 8 * 60 * 1000);
}

function startListening() {
  if (listening || !speechCfg) return;
  const SDK = window.SpeechSDK;
  recognizer = new SDK.SpeechRecognizer(speechCfg, SDK.AudioConfig.fromDefaultMicrophoneInput());
  let heard = '';

  recognizer.recognizing = (_s, e) => { ui.heard.textContent = heard + ' ' + e.result.text; };
  recognizer.recognized = (_s, e) => {
    if (e.result.reason === SDK.ResultReason.RecognizedSpeech && e.result.text) {
      heard = (heard + ' ' + e.result.text).trim();
      ui.heard.textContent = heard;
    }
  };

  recognizer.startContinuousRecognitionAsync();
  listening = true;
  cancelIdle();
  ui.micBtn.classList.add('on');
  ui.micBtn.textContent = 'Listening — release to send';

  recognizer._heard = () => heard;
}

function stopListening() {
  if (!listening || !recognizer) return;
  listening = false;
  ui.micBtn.classList.remove('on');
  ui.micBtn.textContent = 'Hold to talk';

  const grab = recognizer._heard;
  recognizer.stopContinuousRecognitionAsync(() => {
    const text = (grab?.() || '').trim();
    recognizer.close();
    recognizer = null;
    if (text) say(text);
    else armIdle();
  });
}

/* ---------------- wiring ---------------- */

fetch('/api/cast')
  .then((r) => r.json())
  .then((d) => { ui.premise.textContent = d.story.premise; })
  .catch(() => { ui.premise.textContent = 'Night drive. Two lanes. Nobody else out here.'; });

// preload sound effects so they fire with zero network delay
for (const n of SFX_NAMES) {
  fetch(`sfx/${n}.wav`)
    .then((r) => r.blob())
    .then((b) => sfxCache.set(n, URL.createObjectURL(b)))
    .catch(() => {});
}

ui.startBtn.onclick = async () => {
  ui.startBtn.disabled = true;
  ui.startBtn.textContent = 'Starting…';
  try {
    await initSpeech();
  } catch (err) {
    console.warn('speech unavailable, typing still works', err);
    ui.micBtn.disabled = true;
    ui.micBtn.textContent = 'Mic unavailable — type instead';
  }
  ui.startCard.hidden = true;
  ui.game.hidden = false;
  connect();
};

ui.micBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); startListening(); });
ui.micBtn.addEventListener('pointerup', (e) => { e.preventDefault(); stopListening(); });
ui.micBtn.addEventListener('pointerleave', () => { if (listening) stopListening(); });

ui.form.onsubmit = (e) => {
  e.preventDefault();
  const v = ui.input.value;
  ui.input.value = '';
  say(v);
};
