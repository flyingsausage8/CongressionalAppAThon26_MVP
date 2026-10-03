const $ = (id) => document.getElementById(id);

const ui = {
  startCard: $('startCard'), startBtn: $('startBtn'), premise: $('premise'), storyList: $('storyList'),
  game: $('game'), script: $('script'), status: $('status'), dot: $('dot'),
  latency: $('latency'), heard: $('heardText'), micBtn: $('micBtn'),
  form: $('typeForm'), input: $('typeInput'), nudge: $('nudge'),
  progress: $('progress'), restart: $('restartBtn'),
  sceneNow: $('sceneNow'), conditions: $('conditions'), facts: $('facts'),
  savesWrap: $('savesWrap'), saveList: $('saveList'),
  driverToggle: $('driverMode'), driverBar: $('driverBar'), driverHint: $('driverHint'),
};

const IDLE_MS = 25000;       // hands-on mode: how long before we prod you
const ANSWER_MS = 5000;      // driver mode: how long a question waits before we ask again
const SETTLE_MS = 1300;      // driver mode: silence that means "they have finished talking"

let ws, speechCfg, recognizer, listening = false, idleTimer = null;
let storyOver = false;
let chosenStory = null;
let resumeId = null;

/* ---------------- driver mode: hands free, mic always open ---------------- */

const driver = {
  on: false,
  phase: 'idle',    // idle | telling | answering | paused
  buffer: '',
  pending: '',      // an answer that arrived while we were still talking
  quietSince: 0,    // when the speakers actually went silent
  lastPlayEnd: 0,   // wall clock of the last audio frame we played
  micT0: 0,         // wall clock of when the recogniser session started
  settle: null,
  wait: null,
  urges: 0,
};

const STOP_WORDS = /\b(stop|pause|wait|hold on|quiet|shush)\b/i;
const GO_WORDS = /\b(resume|continue|carry on|keep going|go on|unpause|play|go ahead)\b/i;
const FILLER = /^(u+m+|u+h+|e+r+|h+m+|m+h*|a+h+|o+h+|well|like|so|erm)$/i;

/** Did they actually say something, or just make a noise? */
function isRealAnswer(text) {
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.test(w));
  return words.length > 0;
}

/** A command only counts if it was said on its own - stops characters triggering it. */
function isCommand(text, re) {
  const t = String(text).trim().replace(/[.!?,]+$/, '');
  if (t.split(/\s+/).length > 3 || !re.test(t)) return false;
  return !isEcho(t);
}

/** The mic hears the speakers too. If the words are in the line being played, ignore them. */
function isEcho(text) {
  if (queue.paused) return false;               // nothing is sounding, so nothing can echo
  const now = (queue.nowText || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ');
  if (!now) return false;
  return now.includes(String(text).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim());
}

/** Same idea, but against everything the characters have said so far this turn. */
function isEchoOfTurn(text) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const t = norm(text);
  if (!t) return true;

  // One blob, because the mic often transcribes several lines as a single run of speech.
  const blob = norm(spokenThisTurn.join(' '));
  if (!blob) return false;
  if (blob.includes(t)) return true;

  // Speech recognition mangles the odd word, so fall back to how much of it we recognise.
  const words = t.split(' ');
  if (words.length < 3) return false;
  const have = new Set(blob.split(' '));
  const hits = words.filter((w) => have.has(w)).length;
  return hits / words.length >= 0.7;
}

function driverHint(text, cls = '') {
  ui.driverHint.textContent = text;
  ui.driverBar.className = 'driverBar ' + cls;
}

function clearAnswerTimers() {
  clearTimeout(driver.settle);
  clearTimeout(driver.wait);
  driver.settle = null;
  driver.wait = null;
}

/** The story is talking. Nothing you say matters except "stop". */
function driverTelling() {
  if (!driver.on) return;
  // An answer that landed while an urge was already in flight must not be thrown away.
  if (driver.phase === 'answering' && isRealAnswer(driver.buffer)) driver.pending = driver.buffer.trim();
  clearAnswerTimers();
  driver.phase = 'telling';
  driver.buffer = '';
  driverHint('Say \u201cstop\u201d to pause');
}

/** A question has just landed. Wait, then ask again if nothing comes back. */
function driverAwaitAnswer() {
  if (!driver.on || storyOver) return;
  clearAnswerTimers();
  driver.phase = 'answering';
  driver.buffer = '';
  driver.quietSince = Date.now();

  if (driver.pending) {                      // they answered while an urge was in flight
    const held = driver.pending;
    driver.pending = '';
    driver.urges = 0;
    say(held);
    return;
  }

  driverHint('Your turn \u2014 just say it', 'live');
  driver.wait = setTimeout(urgeAgain, ANSWER_MS);
}

function urgeAgain() {
  if (!driver.on || driver.phase !== 'answering' || storyOver) return;
  if (ws?.readyState !== WebSocket.OPEN) return;
  driver.urges++;
  driverHint('Still with us?', 'think');
  ws.send(JSON.stringify({ t: 'idle', level: driver.urges }));
}

/** Everything the mic hears while driver mode is on comes through here. */
function driverHeard(text, final, startMs) {
  if (!driver.on || !text.trim()) return;

  // Did this speech begin while the characters were still sounding? If so it belongs to
  // the telling phase - it is either the speakers bleeding into the mic, or words we have
  // already decided to ignore. Either way it is never an answer.
  const overlapped = startMs ? startMs < driver.lastPlayEnd - 150 : queue.playing && !queue.paused;

  if (driver.phase === 'paused') {
    if (final && isCommand(text, GO_WORDS)) {
      queue.resume();
      driver.phase = 'telling';
      driverHint('Say \u201cstop\u201d to pause');
    }
    return;
  }

  if (driver.phase === 'telling') {
    if (final && isCommand(text, STOP_WORDS)) {
      queue.pause();
      driver.phase = 'paused';
      driverHint('Paused \u2014 say \u201cresume\u201d', 'err');
    }
    return;                                  // no barge-in: the story keeps its floor
  }

  if (driver.phase !== 'answering') return;

  if (final) {
    if (overlapped) return;
    // Fallback for when the recogniser gives us no timings: a result that lands right as
    // the speakers stop, made of their words, is the tail of their line.
    if (Date.now() - driver.quietSince < 600 && isEchoOfTurn(text)) return;
  }

  clearTimeout(driver.wait);                 // they are speaking, so stop counting down
  driver.wait = null;

  if (!final) {
    ui.heard.textContent = (driver.buffer + ' ' + text).trim();
    driverHint('Listening\u2026', 'live');
    return;
  }

  driver.buffer = (driver.buffer + ' ' + text).trim();
  ui.heard.textContent = driver.buffer;

  clearTimeout(driver.settle);
  driver.settle = setTimeout(() => {
    const answer = driver.buffer.trim();
    driver.buffer = '';
    if (isRealAnswer(answer)) {
      driver.urges = 0;
      say(answer);
    } else {
      driverHint('Didn\u2019t catch that', 'err');
      driver.wait = setTimeout(urgeAgain, 1500);
    }
  }, SETTLE_MS);
}

function setStatus(text, cls = '') {
  ui.status.textContent = text;
  ui.dot.className = 'dot ' + cls;
}

function finishStory() {
  cancelIdle();
  clearAnswerTimers();
  driver.phase = 'idle';
  addEnding();
  setStatus('finished', '');
  stopAlwaysListening();
  ui.driverBar.hidden = true;
  ui.micBtn.disabled = true;
  ui.micBtn.textContent = 'The story is over';
  ui.input.disabled = true;
  ui.restart.hidden = false;
}

/* ---------------- playback queue: TTS runs in parallel, audio plays in order -------------
   Every turn gets an epoch. Anything belonging to an older epoch is ignored, so a turn that
   is still playing when the next one starts cannot corrupt the new turn's position.        */

const queue = {
  epoch: 0,
  items: new Map(),   // idx -> { kind, src }
  next: 0,            // index we are waiting to play
  total: null,        // line count, known once turnEnd arrives
  playing: false,
  paused: false,
  nowText: '',        // the line currently sounding, so we can spot microphone echo
  current: null,      // the <audio> actually sounding right now

  add(epoch, idx, item) {
    if (epoch !== this.epoch) return;
    this.items.set(idx, item);
    this.pump();
  },

  async pump() {
    if (this.playing || this.paused) return;
    const epoch = this.epoch;
    const item = this.items.get(this.next);
    if (!item) return;

    this.playing = true;
    this.items.delete(this.next);
    const idx = this.next;
    this.nowText = lineText.get(`${epoch}:${idx}`) || '';

    markLine(epoch, idx, 'playing');
    if (item.kind !== 'skip') {
      try {
        await this.sound(item.src);
      } catch (err) {
        console.warn('playback failed', err);
      }
    }

    // a new turn started while this clip played - abandon this chain
    if (epoch !== this.epoch) return;

    markLine(epoch, idx, 'done');
    this.next++;
    this.playing = false;
    this.pump();
    this.checkDone();
  },

  sound(src) {
    return new Promise((resolve) => {
      const a = new Audio(src);
      this.current = a;
      // Keep a running mark of "the speakers were live until now", so we can throw away
      // anything the microphone picked up while they were talking.
      const tick = setInterval(() => { driver.lastPlayEnd = Date.now(); }, 100);
      const fin = () => {
        clearInterval(tick);
        driver.lastPlayEnd = Date.now();
        if (this.current === a) this.current = null;
        resolve();
      };
      a.onended = fin;
      a.onerror = fin;
      a.play().catch(fin);
    });
  },

  /** True only when every line of this turn has finished sounding. */
  checkDone() {
    if (this.total === null || this.playing || this.paused) return false;
    if (this.next < this.total || this.items.size) return false;
    if (storyOver) {
      finishStory();
    } else {
      setStatus('your turn', 'live');
      armIdle();
      driverAwaitAnswer();
    }
    return true;
  },

  endTurn(epoch, total) {
    if (epoch !== this.epoch) return;
    this.total = total;
    this.checkDone();
  },

  /** Starts a fresh turn. Silences anything still playing. */
  reset() {
    this.epoch++;
    this.items.clear();
    this.next = 0;
    this.total = null;
    this.playing = false;
    this.paused = false;
    this.nowText = '';
    spokenThisTurn.length = 0;
    this.stop();
  },

  /** Driver mode: hold the clip exactly where it is until they say resume. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.current) this.current.pause();
  },

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.current) {
      this.current.play().catch(() => {});
    } else {
      this.pump();
      this.checkDone();
    }
  },

  stop() {
    if (this.current) {
      this.current.pause();
      this.current.onended = null;
      this.current.onerror = null;
      this.current = null;
    }
  },
};

/* ---------------- script rendering ---------------- */

/** What each line actually says, so we can tell the speakers apart from the driver. */
const lineText = new Map();
const spokenThisTurn = [];

function addLine(epoch, idx, line) {
  const el = document.createElement('div');
  el.className = 'ln';
  el.dataset.key = `${epoch}:${idx}`;
  lineText.set(`${epoch}:${idx}`, line.text);
  spokenThisTurn.push(line.text);
  const name = line.as || line.voice;
  const tone = line.tone ? ` <span class="tone">(${esc(line.tone)})</span>` : '';
  el.innerHTML = `<span class="who v-${esc(line.voice)}">${esc(name)}</span>${esc(line.text)}${tone}`;
  ui.script.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/** Your own answers stay in the transcript, in order, between the story beats. */
function addYou(text) {
  const el = document.createElement('div');
  el.className = 'ln you-line done';
  el.innerHTML = `<span class="who">you</span>${esc(text)}`;
  ui.script.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function addEnding() {
  const el = document.createElement('div');
  el.className = 'theEnd';
  el.textContent = 'The End';
  ui.script.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/** Silent replay of the last few lines when a saved story is picked up again. */
function addRecap(lines) {
  const wrap = document.createElement('div');
  wrap.className = 'recap';
  wrap.innerHTML =
    '<div class="recapHead">Previously</div>' +
    lines
      .map((l) =>
        l.you
          ? `<div class="ln you-line done"><span class="who">you</span>${esc(l.text)}</div>`
          : `<div class="ln done"><span class="who v-${esc(l.voice)}">${esc(l.as || l.voice)}</span>${esc(l.text)}</div>`,
      )
      .join('');
  ui.script.appendChild(wrap);
}

function markLine(epoch, idx, cls) {
  const el = ui.script.querySelector(`.ln[data-key="${epoch}:${idx}"]`);
  if (el) el.classList.add(cls);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- live state: conditions, scene, what we know ---------------- */

function renderState(state) {
  if (!state) return;
  ui.sceneNow.textContent = state.scene || '';

  const rows = Object.entries(state.cast || {})
    .filter(([id, c]) => c.condition && (state.seen || []).includes(id))
    .map(([id, c]) => `<div class="cond"><span class="who v-${esc(id)}">${esc(c.name || id)}</span>${esc(c.condition)}</div>`);

  const props = Object.entries(state.props || {})
    .map(([k, v]) => `<div class="cond"><span class="who prop">${esc(k)}</span>${esc(v)}</div>`);

  const you = state.you ? `<div class="cond"><span class="who mine">you</span>${esc(state.you)}</div>` : '';

  ui.conditions.innerHTML = you + rows.join('') + props.join('');
  ui.facts.innerHTML = (state.learned || []).length
    ? `<h3>What we know</h3><ul>${state.learned.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
    : '';
}

/* ---------------- idle nudge: the whole point of the game ---------------- */

function armIdle() {
  clearTimeout(idleTimer);
  if (driver.on) return;                 // driver mode runs its own, much shorter clock
  if (!ui.nudge?.checked) return;
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
    ws.send(JSON.stringify({ t: 'start', storyId: chosenStory, resumeId }));
  };

  ws.onclose = () => setStatus('disconnected', 'err');
  ws.onerror = () => setStatus('connection error', 'err');

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);

    if (m.t === 'storyStarted') {
      document.title = `${m.title} — Stay Awake`;
      document.querySelector('h1').textContent = m.title;
      if (m.resumed && m.recap?.length) addRecap(m.recap);
    } else if (m.t === 'thinking') {
      cancelIdle();
      queue.reset();
      driverTelling();
      setStatus('writing…', 'think');
    } else if (m.t === 'line') {
      addLine(queue.epoch, m.idx, m);
    } else if (m.t === 'audio') {
      const bytes = Uint8Array.from(atob(m.mp3), (c) => c.charCodeAt(0));
      queue.add(queue.epoch, m.idx, {
        kind: 'audio',
        src: URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })),
      });
      setStatus('playing', 'live');
    } else if (m.t === 'audioError') {
      queue.add(queue.epoch, m.idx, { kind: 'skip' });
    } else if (m.t === 'turnEnd') {
      ui.latency.textContent = m.firstAudioMs ? `${m.firstAudioMs}ms` : '';
      ui.progress.textContent = `exchange ${m.turn}`;
      renderState(m.state);
      storyOver = !!m.done;
      queue.endTurn(queue.epoch, m.idx);
    } else if (m.t === 'error') {
      setStatus('error: ' + m.message, 'err');
      armIdle();
    }
  };
}

function say(text) {
  if (!text?.trim() || storyOver || ws?.readyState !== WebSocket.OPEN) return;
  cancelIdle();
  driverTelling();
  addYou(text.trim());
  ui.heard.textContent = '';
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

/** Driver mode: one recogniser, opened once, never closed until the story ends. */
async function startAlwaysListening() {
  if (listening || !speechCfg) return;
  const SDK = window.SpeechSDK;

  // Ask the browser for an echo-cancelled stream. Without this the microphone hears the
  // characters through the speakers and we submit the story's own words as your answer.
  let audioCfg;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    audioCfg = SDK.AudioConfig.fromStreamInput(stream);
  } catch (err) {
    console.warn('no echo-cancelled stream, falling back', err);
    audioCfg = SDK.AudioConfig.fromDefaultMicrophoneInput();
  }

  recognizer = new SDK.SpeechRecognizer(speechCfg, audioCfg);
  driver.micT0 = Date.now();

  recognizer.recognizing = (_s, e) => driverHeard(e.result.text || '', false, startOf(e));
  recognizer.recognized = (_s, e) => {
    if (e.result.reason === SDK.ResultReason.RecognizedSpeech && e.result.text) {
      driverHeard(e.result.text, true, startOf(e));
    }
  };
  recognizer.sessionStarted = () => { driver.micT0 = Date.now(); };
  recognizer.canceled = (_s, e) => {
    console.warn('recognition canceled', e.errorDetails || e.reason);
    relisten();
  };
  recognizer.sessionStopped = () => relisten();

  recognizer.startContinuousRecognitionAsync();
  listening = true;
  ui.driverBar.hidden = false;
  driverHint('Listening');
}

/** Wall-clock time the speech in this result began. */
function startOf(e) {
  const off = Number(e?.result?.offset);
  return Number.isFinite(off) && off > 0 ? driver.micT0 + off / 10000 : 0;
}

/** The mic must never quietly die on a driver. */
function relisten() {
  if (!driver.on || storyOver || !listening) return;
  listening = false;
  const old = recognizer;
  recognizer = null;
  try { old?.close(); } catch { /* already gone */ }
  setTimeout(() => { if (driver.on && !storyOver) startAlwaysListening(); }, 600);
}

function stopAlwaysListening() {
  if (!driver.on || !recognizer) return;
  listening = false;
  const r = recognizer;
  recognizer = null;
  r.stopContinuousRecognitionAsync(() => r.close(), () => r.close());
}

function startListening() {
  if (listening || !speechCfg) return;
  queue.stop();           // barge-in: your voice cuts the characters off
  cancelIdle();
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

fetch('/api/stories')
  .then((r) => r.json())
  .then(({ stories, saves, default: def }) => {
    for (const s of stories) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'storyPick';
      b.dataset.id = s.id;
      b.innerHTML = `<strong>${esc(s.title)}</strong><span>${esc(s.blurb)}</span>`;
      b.onclick = () => pick(s);
      ui.storyList.appendChild(b);
    }

    if (saves?.length) {
      ui.savesWrap.hidden = false;
      for (const s of saves) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'storyPick save';
        b.dataset.save = s.id;
        const when = new Date(s.savedAt).toLocaleString();
        b.innerHTML =
          `<strong>${esc(s.title)} <em>&middot; exchange ${s.turn}${s.done ? ', ended' : ''}</em></strong>` +
          `<span>${esc(s.scene || when)}</span>`;
        b.onclick = () => pickSave(s);
        ui.saveList.appendChild(b);
      }
    }

    const first = stories.find((s) => s.id === def) || stories[0];
    if (first) pick(first);
  })
  .catch(() => { ui.premise.textContent = 'Could not load the stories.'; });

function clearPicks() {
  for (const b of ui.storyList.children) b.classList.remove('on');
  for (const b of ui.saveList.children) b.classList.remove('on');
}

function pick(s) {
  chosenStory = s.id;
  resumeId = null;
  ui.premise.innerHTML = `<em>${esc(s.you)}</em><br><br>${esc(s.goal)}`;
  ui.startBtn.disabled = false;
  ui.startBtn.textContent = 'Begin';
  clearPicks();
  for (const b of ui.storyList.children) b.classList.toggle('on', b.dataset.id === s.id);
}

function pickSave(s) {
  resumeId = s.id;
  chosenStory = s.storyId;
  ui.premise.innerHTML = `<em>Carrying on from exchange ${s.turn}.</em><br><br>${esc(s.scene || '')}`;
  ui.startBtn.disabled = false;
  ui.startBtn.textContent = 'Carry on';
  clearPicks();
  for (const b of ui.saveList.children) b.classList.toggle('on', b.dataset.save === s.id);
}

ui.restart.onclick = () => location.reload();

ui.startBtn.onclick = async () => {
  if (!chosenStory) return;
  driver.on = !!ui.driverToggle?.checked;
  ui.startBtn.disabled = true;
  ui.startBtn.textContent = 'Starting…';
  let micOk = true;
  try {
    await initSpeech();
  } catch (err) {
    console.warn('speech unavailable, typing still works', err);
    micOk = false;
    driver.on = false;
    ui.micBtn.disabled = true;
    ui.micBtn.textContent = 'Mic unavailable — type instead';
  }
  ui.startCard.hidden = true;
  ui.game.hidden = false;

  if (driver.on) {
    ui.micBtn.hidden = true;               // hands free: there is nothing to hold
    ui.form.hidden = true;
    startAlwaysListening();
  }
  if (micOk && !driver.on) ui.driverBar.hidden = true;

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
