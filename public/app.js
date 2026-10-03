const $ = (id) => document.getElementById(id);

const ui = {
  startCard: $('startCard'), startBtn: $('startBtn'), premise: $('premise'), storyList: $('storyList'),
  game: $('game'), script: $('script'), status: $('status'), dot: $('dot'),
  latency: $('latency'), heard: $('heardText'), micBtn: $('micBtn'),
  form: $('typeForm'), input: $('typeInput'), nudge: $('nudge'),
  progress: $('progress'), restart: $('restartBtn'),
  sceneNow: $('sceneNow'), conditions: $('conditions'), facts: $('facts'),
  savesWrap: $('savesWrap'), saveList: $('saveList'),
};

const IDLE_MS = 25000;

let ws, speechCfg, recognizer, listening = false, idleTimer = null;
let storyOver = false;
let chosenStory = null;
let resumeId = null;

function setStatus(text, cls = '') {
  ui.status.textContent = text;
  ui.dot.className = 'dot ' + cls;
}

function finishStory() {
  cancelIdle();
  addEnding();
  setStatus('finished', '');
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
  current: null,      // the <audio> actually sounding right now

  add(epoch, idx, item) {
    if (epoch !== this.epoch) return;
    this.items.set(idx, item);
    this.pump();
  },

  async pump() {
    if (this.playing) return;
    const epoch = this.epoch;
    const item = this.items.get(this.next);
    if (!item) return;

    this.playing = true;
    this.items.delete(this.next);
    const idx = this.next;

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
      const fin = () => {
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
    if (this.total === null || this.playing) return false;
    if (this.next < this.total || this.items.size) return false;
    if (storyOver) {
      finishStory();
    } else {
      setStatus('your turn', 'live');
      armIdle();
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
    this.stop();
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

function addLine(epoch, idx, line) {
  const el = document.createElement('div');
  el.className = 'ln';
  el.dataset.key = `${epoch}:${idx}`;
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
