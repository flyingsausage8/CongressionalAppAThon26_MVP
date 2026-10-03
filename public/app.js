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
  driverStats: $('driverStats'),
  trace: $('trace'), traceHead: $('traceHead'), traceClear: $('traceClear'),
};

const IDLE_MS = 25000;       // hands-on mode: how long before we prod you
const ANSWER_MS = 9000;      // driver mode: how long we listen before asking again
const SETTLE_MS = 1000;      // driver mode: one second of quiet means they have finished
const MIC_GAP_MS = 100;      // fallback only; the real speaker lag is measured, see speakerLagMs()
const UNKNOWN_LAG_MS = 350;  // used when the browser cannot measure it (remote desktops report 0)
const SOUND_HOLD_MS = 1500;  // never nudge someone whose voice we can already hear

let ws, speechCfg, recognizer, listening = false, idleTimer = null;
let starting = false;        // a microphone is being opened right now; do not open a second
let storyOver = false;
let chosenStory = null;
let resumeId = null;
let currentSaveId = null;    // what to resume from if the connection drops
let reconnects = 0;
let silentRecap = false;     // a reconnect should not reprint what is already on screen

/* ---------------- driver mode: hands free, mic always open ---------------- */

const driver = {
  on: false,
  phase: 'idle',    // idle | telling | answering | paused
  buffer: '',
  pending: '',      // an answer that arrived while we were still talking
  quietSince: 0,    // when the speakers actually went silent
  lastPlayEnd: 0,   // wall clock of the last audio frame we played
  micT0: 0,         // wall clock of when the recogniser session started
  utterStart: 0,    // wall clock of when the current run of speech began
  askedAt: 0,       // wall clock of when the question finished, so we can time the answer
  gap: null,        // the deliberate stretch of microphone silence between turns
  gapMs: MIC_GAP_MS, // how long that gap needs to be on this device
  lastEventAt: 0,   // last sign of life from the microphone
  stream: null,     // the live microphone track, so we can tell if it really died
  settle: null,
  wait: null,
  urges: 0,
  micGen: 0,        // which microphone attempt is live; stale callbacks compare against it
  nudging: false,   // the line being spoken is a repeat of the question, so answer over it
  windowStart: 0,   // when the current listening window opened
  thinkMs: 0,       // time they have actually been left to think, nudges excluded
  spokeAt: 0,       // when they first spoke in answer to this question
  replyMs: 0,       // how long that took them, once known
  lastSoundAt: 0,   // last moment the microphone carried real sound
};

const STOP_WORDS = /\b(stop|pause|wait|hold on|quiet|shush)\b/i;
const GO_WORDS = /\b(resume|continue|carry on|keep going|go on|unpause|play|go ahead)\b/i;
const FILLER = /^(u+m+|u+h+|e+r+|h+m+|m+h*|a+h+|o+h+|well|like|so|erm)$/i;

/* ---- echo guards, switched OFF --------------------------------------------------------
   These used to inspect everything the mic heard and try to work out which words came from
   the speakers. They are no longer used. While the characters talk, the phase is "telling"
   and nothing except "stop" is kept anyway; and the moment they finish, the microphone is
   cut until their sound has physically left the speakers, so their last line can no longer
   get glued onto the front of an answer. The code below is kept, tested, and one flag away
   in case the muting turns out not to be enough on some device.                          */
const ECHO_GUARDS = false;

/** Did they actually say something, or just make a noise? */
function isRealAnswer(text) {
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.test(w));
  return words.length > 0;
}

/**
 * A command only counts if it was said on its own. This one echo check stays on even with
 * ECHO_GUARDS off: the mic is deliberately left open during playback so "stop" works, and
 * without it a character saying "Wait." pauses the story on itself and never restarts.
 */
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
const NUMBERS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', hundred: '100',
};

function normWords(s) {
  return String(s)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")          // curly apostrophes, which the recogniser likes
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // The script writes "two silver" and the recogniser hears "2 silver". Left unmatched,
    // a whole question slips past the echo check and gets sent back as the answer.
    .split(' ')
    .map((w) => NUMBERS[w] || w)
    .join(' ');
}

function isEchoOfTurn(text) {
  const norm = normWords;
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

/** Cut the characters' own words off the front of something the mic heard. */
function stripEcho(text) {
  const blob = ' ' + normWords(spokenThisTurn.join(' ')) + ' ';
  const words = normWords(text).split(' ').filter(Boolean);
  if (blob.trim() === '' || !words.length) return normWords(text);

  // Longest run from the start that the characters actually said. Checked longest-first so
  // a real answer that merely repeats an option word is not mistaken for the whole echo.
  for (let n = Math.min(words.length, 30); n >= 1; n--) {
    if (blob.includes(' ' + words.slice(0, n).join(' ') + ' ')) return words.slice(n).join(' ');
  }
  return words.join(' ');
}

function driverHint(text, cls = '') {
  ui.driverHint.textContent = text;
  ui.driverBar.className = 'driverBar ' + cls;
}

function clearAnswerTimers() {
  clearTimeout(driver.settle);
  clearTimeout(driver.wait);
  clearTimeout(driver.gap);
  driver.settle = null;
  driver.wait = null;
  driver.gap = null;
}

/**
 * How far the speakers lag behind the code. "ended" fires when the audio element has handed
 * over its last sample, but that sample has not reached the driver's ears yet. Where the
 * browser can measure the delay we use its number. Where it cannot - it reports zero on
 * remote desktops, and the sound there is travelling over a network - a small guess would
 * be badly wrong, so we wait a conservative beat instead.
 */
function speakerLagMs() {
  const ctx = driver.audioCtx;
  const sec = Number(ctx?.outputLatency) || 0;
  if (!sec) return UNKNOWN_LAG_MS;                 // the browser has no idea; assume the worst
  return Math.min(600, Math.max(80, Math.round(sec * 1000) + 30));   // + a little for the room
}

/** The story is talking. Nothing you say matters except "stop". */
function driverTelling() {
  if (!driver.on) return;
  // An answer that landed while an urge was already in flight must not be thrown away.
  if (driver.phase === 'answering' && isRealAnswer(driver.buffer)) driver.pending = driver.buffer.trim();
  // Time spent listening to the story is not time the driver was given to think. Bank only
  // the part of the wait that was genuinely theirs, or a slow nudge makes an alert driver
  // look half asleep.
  if (driver.phase === 'answering' && driver.windowStart) {
    driver.thinkMs += Date.now() - driver.windowStart;
    driver.windowStart = 0;
  }
  clearAnswerTimers();
  driver.phase = 'telling';
  driver.buffer = '';
  driverHint('Say \u201cstop\u201d to pause');
}

/**
 * The characters have stopped. The audio element reports "finished" while its last sound is
 * still on its way to the driver's ears, so nothing counts as an answer until that sound has
 * actually arrived. We do NOT switch the microphone track off to achieve this: doing so makes
 * the speech service think the stream has ended, and it closes the session and has to be
 * rebuilt, which costs a second and a half of total deafness. The phase alone is the gate.
 */
function driverAwaitAnswer() {
  if (!driver.on || storyOver) return;
  clearAnswerTimers();
  driver.phase = 'gap';
  driver.buffer = '';
  driverHint('\u2026');

  driver.gapMs = speakerLagMs();
  trace.mark(`audio finished - waiting ${driver.gapMs}ms for the speakers to catch up`);
  micReport('played', `last line ended; waiting ${driver.gapMs}ms for the speakers`);
  driver.gap = setTimeout(beginAnswering, driver.gapMs);
}

function beginAnswering() {
  if (!driver.on || storyOver) return;
  driver.phase = 'answering';
  driver.nudging = false;
  driver.buffer = '';
  driver.quietSince = Date.now();
  // A nudge repeats the same question, so it must not restart the clock. Only a genuinely
  // new question does, and that is marked by the answer to the last one being sent.
  if (!driver.askedAt) {
    driver.askedAt = Date.now();
    driver.thinkMs = 0;
    driver.spokeAt = 0;
    driver.replyMs = 0;
  }
  driver.windowStart = Date.now();
  driver.sawInterim = false;
  driver.heardSound = false;
  driver.peak = 0;
  driver.utterStart = 0;
  micReport('listening', `window open; thinking time so far ${Math.round(driver.thinkMs / 100) / 10}s`);

  if (driver.pending) {                      // they answered while an urge was in flight
    const held = driver.pending;
    driver.pending = '';
    driver.urges = 0;
    say(held);
    return;
  }

  driverHint('Your turn \u2014 just say it', 'live');
  trace.add('mic', `RECORDING - ${ANSWER_MS / 1000}s before it asks again`);
  // The clock starts here, the moment the microphone is actually live again - not when the
  // last line ended, so none of their five seconds is spent waiting for the speakers.
  driver.wait = setTimeout(urgeAgain, ANSWER_MS);
}

function urgeAgain() {
  if (!driver.on || driver.phase !== 'answering' || storyOver) return;
  if (ws?.readyState !== WebSocket.OPEN) return;
  // The level meter sees sound roughly a second before the words come back from the speech
  // service. Without this check the nudge talks straight over a driver who is already
  // halfway through their answer, and then that answer is binned as "story talking".
  if (driver.lastSoundAt && Date.now() - driver.lastSoundAt < SOUND_HOLD_MS) {
    trace.add('ear', 'nudge held back - it can hear you speaking');
    driver.wait = setTimeout(urgeAgain, SOUND_HOLD_MS);
    return;
  }
  driver.urges++;
  driver.nudging = true;                     // what follows is the question, not a story beat
  trace.add('wait', `NUDGE #${driver.urges} requested - writing it now`);
  driverHint('Still with us?', 'think');
  micReport('urge', `#${driver.urges} sound:${driver.heardSound ? 'yes' : 'no'} words:${driver.sawInterim ? 'yes' : 'no'}`);
  ws.send(JSON.stringify({ t: 'idle', level: driver.urges }));
}

/**
 * Mark the moment they began answering, and work out how long that took them. Only the
 * stretches where the microphone was actually theirs count: the seconds the story spent
 * writing and speaking a nudge were never thinking time, and counting them turned a
 * four-second answer into a twenty-second one.
 */
function noteSpoke() {
  if (driver.spokeAt) return;
  driver.spokeAt = Date.now();
  driver.lastSoundAt = driver.spokeAt;
  driver.replyMs = driver.thinkMs + (driver.windowStart ? driver.spokeAt - driver.windowStart : 0);
  trace.add('ear', `HEARD YOU START - counted as ${(driver.replyMs / 1000).toFixed(1)}s to answer`);
}

/**
 * A running account of what driver mode is deciding, on screen beside the story. Timestamps
 * are relative to the last question so "it nudged me too early" can be read straight off it.
 */
const trace = {
  t0: 0,
  on: false,
  add(kind, what) {
    if (!this.on || !ui.trace) return;
    const at = this.t0 ? (Date.now() - this.t0) / 1000 : 0;
    const row = document.createElement('div');
    row.className = `tr ${kind}`;
    row.innerHTML = `<span class="tt">+${at.toFixed(1)}s</span><span class="tw"></span>`;
    row.lastChild.textContent = what;
    ui.trace.appendChild(row);
    while (ui.trace.children.length > 300) ui.trace.firstChild.remove();
    ui.trace.scrollTop = ui.trace.scrollHeight;
  },
  /** Restart the stopwatch - a new question is the thing everything else is measured from. */
  mark(what) {
    this.t0 = Date.now();
    this.add('wait', what);
  },
  show() {
    this.on = true;
    if (ui.trace) ui.trace.hidden = false;
    if (ui.traceHead) ui.traceHead.hidden = false;
  },
};

/** Everything the mic hears while driver mode is on comes through here. */
function driverHeard(text, final, startMs) {
  if (!driver.on || !text.trim()) return;

  // Wall clock of when this run of speech began. The recogniser's own offsets drift over a
  // long session, so we trust the moment the first interim result arrived instead.
  if (!driver.utterStart) driver.utterStart = Date.now();
  const began = driver.utterStart;
  if (final) driver.utterStart = 0;

  // Did this speech begin while the characters were still sounding? The microphone is cut
  // for MIC_GAP_MS after the last line, so anything starting before that is theirs, not yours.
  const overlapped = ECHO_GUARDS && (began < driver.lastPlayEnd + driver.gapMs
    || (startMs ? startMs < driver.lastPlayEnd - 150 : queue.playing && !queue.paused));

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
      return;
    }
    // A nudge is the same question again. It takes a couple of seconds to write and a few
    // more to speak, and a driver who answers in that window was binned as "story talking"
    // even though nothing was playing yet. Their words count.
    if (!driver.nudging) {
      if (final) { micReport('dropped', `while story talking: "${text}"`); trace.add('bad', `IGNORED (story talking): "${text}"`); }
      return;                                // no barge-in: the story keeps its floor
    }
  } else if (driver.phase !== 'answering') {
    if (final) { micReport('dropped', `phase ${driver.phase}: "${text}"`); trace.add('bad', `IGNORED (${driver.phase}): "${text}"`); }
    return;
  }

  if (final && overlapped) {
    // The characters' tail and the answer often arrive glued into one result, like
    // "Which do you choose? Let's go forward." Cut their words off the front and keep
    // whatever is left - throwing the whole thing away loses a real answer.
    const kept = stripEcho(text);
    if (!isRealAnswer(kept) || isEchoOfTurn(kept)) {
      micReport('dropped', `echo of the characters: "${text}"`);
      return;
    }
    if (kept !== text.trim()) micReport('trimmed', `"${text}" -> "${kept}"`);
    text = kept;
  }

  clearTimeout(driver.wait);                 // they are speaking, so stop counting down
  driver.wait = null;

  if (!final) {
    noteSpoke();
    ui.heard.textContent = (driver.buffer + ' ' + text).trim();
    driverHint('Listening\u2026', 'live');
    return;
  }

  noteSpoke();
  driver.buffer = (driver.buffer + ' ' + text).trim();
  ui.heard.textContent = driver.buffer;

  clearTimeout(driver.settle);
  driver.settle = setTimeout(() => {
    const answer = driver.buffer.trim();
    driver.buffer = '';
    if (isRealAnswer(answer)) {
      micReport('answer', answer.slice(0, 80));
      trace.add('ear', `SENT: "${answer}"`);
      say(answer);                           // say() reads driver.urges, so reset after it
      driver.urges = 0;
    } else {
      micReport('dropped', `nothing but filler: "${answer}"`);
      trace.add('bad', `IGNORED (just a noise): "${answer}"`);
      driverHint('Didn\u2019t catch that', 'err');
      driver.wait = setTimeout(urgeAgain, ANSWER_MS);
    }
  }, SETTLE_MS);
}

function setStatus(text, cls = '') {
  ui.status.textContent = text;
  ui.dot.className = 'dot ' + cls;
}

/** How awake the listener sounds, big enough to read at a glance. */
function showDriverStats(a) {
  if (!a) { ui.driverStats.hidden = true; return; }
  const label = { awake: 'Wide awake', slowing: 'Slowing down', fading: 'Fading' };
  ui.driverStats.hidden = false;
  ui.driverStats.className = `driverStats ${a.level}`;
  ui.driverStats.innerHTML =
    `<div class="dsHead">${label[a.level]}</div>` +
    `<div class="dsRow"><b>${a.secs}s</b><span>to answer</span></div>` +
    `<div class="dsRow"><b>${a.words}</b><span>words each</span></div>` +
    `<div class="dsRow"><b>${a.nudged}/${a.of}</b><span>needed a nudge</span></div>`;
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
      trace.add('story', `speaking line ${idx + 1}${this.total ? ' of ' + this.total : ''}`);
      try {
        await this.sound(item.src, item.voice);
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
    setStatus(reconnects ? 'back' : 'connected', 'live');
    reconnects = 0;
    ws.send(JSON.stringify({ t: 'start', storyId: chosenStory, resumeId }));
    flushMicBacklog();
  };

  // A driver cannot look at the screen, so a dropped connection must heal itself.
  ws.onclose = () => {
    if (storyOver) return;
    if (!currentSaveId || reconnects >= 6) {
      setStatus('disconnected', 'err');
      if (driver.on) driverHint('Lost the connection', 'err');
      return;
    }
    reconnects++;
    resumeId = currentSaveId;
    silentRecap = true;
    setStatus(`reconnecting (${reconnects})…`, 'think');
    if (driver.on) driverHint('Lost you for a second\u2026', 'think');
    setTimeout(connect, Math.min(1000 * reconnects, 5000));
  };

  ws.onerror = () => setStatus('connection error', 'err');

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);

    if (m.t === 'storyStarted') {
      document.title = `${m.title} — Stay Awake`;
      document.querySelector('h1').textContent = m.title;
      if (m.saveId) currentSaveId = m.saveId;
      if (m.resumed && m.recap?.length && !silentRecap) addRecap(m.recap);
      silentRecap = false;
    } else if (m.t === 'thinking') {
      cancelIdle();
      queue.reset();
      trace.add('story', driver.nudging ? 'writing the nudge\u2026' : 'WRITING THE NEXT SCRIPT\u2026');
      driverTelling();
      setStatus('writing…', 'think');
    } else if (m.t === 'line') {
      addLine(queue.epoch, m.idx, m);
    } else if (m.t === 'audio') {
      const bytes = Uint8Array.from(atob(m.mp3), (c) => c.charCodeAt(0));
      queue.add(queue.epoch, m.idx, {
        kind: 'audio',
        voice: m.voice,
        src: URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })),
      });
      setStatus('playing', 'live');
    } else if (m.t === 'audioError') {
      queue.add(queue.epoch, m.idx, { kind: 'skip' });
    } else if (m.t === 'turnEnd') {
      ui.latency.textContent = m.firstAudioMs ? `${m.firstAudioMs}ms` : '';
      ui.progress.textContent = `exchange ${m.turn}`;
      showDriverStats(m.alert);
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
  // How long they took to answer, and how much prodding it needed. A driver who is nodding
  // off gets slower and shorter, and the story needs to know. Two things are deliberately
  // excluded: the time the story itself was talking, and the time they spent finishing the
  // sentence. Neither is thinking time, and both made alert drivers look drowsy.
  const replyMs = !driver.askedAt ? 0
    : driver.replyMs || driver.thinkMs + (driver.windowStart ? Date.now() - driver.windowStart : 0);
  const urges = driver.urges;
  driver.askedAt = 0;
  driver.spokeAt = 0;
  driver.replyMs = 0;
  driver.thinkMs = 0;
  driver.windowStart = 0;
  if (driver.nudging) queue.stop();          // they answered over a nudge; stop repeating it
  driver.nudging = false;
  cancelIdle();
  driverTelling();
  addYou(text.trim());
  ui.heard.textContent = '';
  ws.send(JSON.stringify({ t: 'say', text, replyMs, urges }));
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
      if (!r.ok) return;
      const { token } = await r.json();
      speechCfg.authorizationToken = token;
      if (recognizer) recognizer.authorizationToken = token;   // a live recogniser needs it too
    } catch { /* keep the old token and hope */ }
  }, 8 * 60 * 1000);
}

/** Driver mode: one recogniser, opened once, never closed until the story ends. */
async function startAlwaysListening() {
  if (listening || starting || !speechCfg) return;
  starting = true;
  const SDK = window.SpeechSDK;
  // Everything below belongs to this attempt. If a newer attempt starts, or this one is
  // torn down, the number moves on and every stale callback below becomes a no-op.
  const gen = ++driver.micGen;
  const stale = () => gen !== driver.micGen;

  // Ask the browser for an echo-cancelled stream. Without this the microphone hears the
  // characters through the speakers and we submit the story's own words as your answer.
  let audioCfg;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (stale()) { stream.getTracks().forEach((t) => t.stop()); starting = false; return; }
    driver.stream = stream;
    audioCfg = SDK.AudioConfig.fromStreamInput(stream);
    watchLevel(stream, gen);
  } catch (err) {
    micReport('no-echo-cancel', String(err?.message || err));
    if (stale()) { starting = false; return; }
    driver.stream = null;
    audioCfg = SDK.AudioConfig.fromDefaultMicrophoneInput();
  }

  recognizer = new SDK.SpeechRecognizer(speechCfg, audioCfg);
  driver.micT0 = Date.now();
  driver.lastEventAt = Date.now();

  recognizer.recognizing = (_s, e) => {
    if (stale()) return;
    driver.lastEventAt = Date.now();
    if (!driver.sawInterim) { driver.sawInterim = true; micReport('hearing', String(e.result.text || '').slice(0, 60)); }
    driverHeard(e.result.text || '', false, startOf(e));
  };
  recognizer.recognized = (_s, e) => {
    if (stale()) return;
    driver.lastEventAt = Date.now();
    if (e.result.reason === SDK.ResultReason.RecognizedSpeech && e.result.text) {
      driverHeard(e.result.text, true, startOf(e));
    } else if (e.result.reason === SDK.ResultReason.NoMatch) {
      micReport('no-match', `phase ${driver.phase}`);     // heard sound, made no words of it
    }
  };
  recognizer.speechStartDetected = () => { if (!stale()) driver.lastEventAt = Date.now(); };
  recognizer.sessionStarted = () => {
    if (stale()) return;
    driver.micT0 = Date.now();
    driver.lastEventAt = Date.now();
    micReport('started');
  };
  recognizer.canceled = (_s, e) => {
    if (stale()) return;                     // a recogniser we already replaced
    micReport('canceled', e?.errorDetails || `reason ${e?.reason}`);
    relisten(gen);
  };
  recognizer.sessionStopped = () => {
    if (stale()) return;                     // likewise: never tear down its replacement
    micReport('stopped', `phase ${driver.phase}, ${Date.now() - driver.lastEventAt}ms since last sign of life`);
    relisten(gen);
  };

  recognizer.startContinuousRecognitionAsync(
    () => { if (stale()) return; listening = true; starting = false; micReport('ready'); },
    (err) => { if (stale()) return; starting = false; micReport('start-failed', String(err)); relisten(gen); },
  );
  listening = true;
  ui.driverBar.hidden = false;
  driverHint('Listening');

  // Resolve once the service has actually accepted us, so nothing is spoken into a void.
  await new Promise((done) => {
    const t = setTimeout(done, 4000);
    const started = recognizer.sessionStarted;
    recognizer.sessionStarted = (s, e) => {
      clearTimeout(t);
      started?.(s, e);
      done();
    };
  });
}

/** Tell the server, so microphone trouble shows up in the transcript. */
const micBacklog = [];
const TRACE_MIC = { started: 'mic', ready: 'mic', stopped: 'bad', canceled: 'bad', 'track-ended': 'bad', 'start-failed': 'bad', 'no-echo-cancel': 'bad' };
function micReport(event, detail = '') {
  console.warn('[mic]', event, detail);
  if (TRACE_MIC[event]) trace.add(TRACE_MIC[event], `microphone ${event}${detail ? ' - ' + detail : ''}`);
  const m = JSON.stringify({ t: 'mic', event, detail });
  if (ws?.readyState === WebSocket.OPEN) ws.send(m);
  else if (micBacklog.length < 50) micBacklog.push(m);   // the mic opens before the socket
}

function flushMicBacklog() {
  while (micBacklog.length && ws?.readyState === WebSocket.OPEN) ws.send(micBacklog.shift());
}

/* Is the microphone actually carrying sound? The recogniser can sit there silently doing
   nothing, and without this we cannot tell a dead mic from a deaf transcriber. */
function watchLevel(stream, gen) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const node = ctx.createAnalyser();
    node.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(node);
    const buf = new Uint8Array(node.fftSize);
    driver.audioCtx = ctx;
    driver.peak = 0;

    clearInterval(driver.levelTimer);
    driver.levelTimer = setInterval(() => {
      if (gen !== driver.micGen) { clearInterval(driver.levelTimer); return; }
      node.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      driver.peak = Math.max(driver.peak, peak);
      driver.levelNow = peak;
      if (driver.phase === 'answering' && peak > 6) {
        driver.heardSound = true;
        driver.lastSoundAt = Date.now();
      }
    }, 100);

    // Every few seconds while we are waiting, say whether sound is arriving at all.
    // This only reports. It must never rebuild the microphone: an earlier version did,
    // and it tore down a perfectly good one mid-answer, leaving the driver unheard.
    clearInterval(driver.levelReport);
    driver.levelReport = setInterval(() => {
      if (gen !== driver.micGen) { clearInterval(driver.levelReport); return; }
      if (driver.phase !== 'answering') { driver.peak = 0; return; }
      const track = stream.getAudioTracks()[0];
      micReport('level', `peak ${driver.peak} ctx ${ctx.state} track ${track?.readyState} muted ${track?.muted}`);
      driver.peak = 0;
    }, 4000);

    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t = stream.getAudioTracks()[0];
    const s = t?.getSettings?.() || {};
    micReport('audio', `echoCancellation ${s.echoCancellation} noiseSuppression ${s.noiseSuppression} ` +
      `device "${t?.label || '?'}" speakerLag ${speakerLagMs()}ms ` +
      `(out ${ctx.outputLatency ?? '?'} base ${ctx.baseLatency ?? '?'})`);
  } catch (err) {
    micReport('level-unavailable', String(err?.message || err));
  }
}

/** Wall-clock time the speech in this result began. */
function startOf(e) {
  const off = Number(e?.result?.offset);
  return Number.isFinite(off) && off > 0 ? driver.micT0 + off / 10000 : 0;
}

/**
 * The mic must never quietly die on a driver. Callers pass the generation they belong to:
 * a recogniser that has already been replaced must not tear down its replacement, which is
 * exactly how a working microphone ended up feeding a stopped stream and hearing nothing.
 */
function relisten(gen) {
  if (!driver.on || storyOver) return;
  if (gen !== undefined && gen !== driver.micGen) return;
  driver.micGen++;                           // every callback from the old one is now dead
  listening = false;
  starting = false;
  clearInterval(driver.levelTimer);
  clearInterval(driver.levelReport);
  try { driver.audioCtx?.close(); } catch { /* ignore */ }
  driver.audioCtx = null;
  const old = recognizer;
  recognizer = null;
  try { old?.close(); } catch { /* already gone */ }
  try { driver.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  driver.stream = null;
  setTimeout(() => { if (driver.on && !storyOver && !listening) startAlwaysListening(); }, 600);
}

/**
 * Is the microphone genuinely dead? Silence is not evidence - a thinking driver makes no
 * sound at all. Only the audio track actually ending counts, so we never tear down a
 * working microphone and swallow the answer being spoken into it.
 */
setInterval(() => {
  if (!driver.on || storyOver) return;
  if (!listening && !starting) { startAlwaysListening(); return; }
  const track = driver.stream?.getAudioTracks?.()[0];
  if (track && track.readyState !== 'live') {
    micReport('track-ended', `readyState ${track.readyState}`);
    relisten();
  }
}, 5000);

function stopAlwaysListening() {
  if (!driver.on || !recognizer) return;
  driver.micGen++;
  listening = false;
  starting = false;
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
if (ui.traceClear) ui.traceClear.onclick = () => { ui.trace.textContent = ''; };

ui.startBtn.onclick = async () => {
  if (!chosenStory) return;
  driver.on = !!ui.driverToggle?.checked;
  if (driver.on) { trace.show(); trace.mark('started'); }
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
    // Wait for the microphone to be genuinely open before a word is spoken, or the first
    // answer lands in a recogniser that is still connecting and is lost.
    await startAlwaysListening();
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
