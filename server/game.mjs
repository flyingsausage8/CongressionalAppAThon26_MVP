import { streamChat, synthesize } from './ai.mjs';
import { getStory, voiceSlots } from './stories.mjs';

const HISTORY_LINES = 24;
const MAX_FACTS = 14;

/**
 * The model is given a situation and a goal - nothing else.
 * No plot, no acts, no planned ending. It finds those with the listener.
 */
function systemPrompt(story) {
  const core = Object.entries(story.cast)
    .map(([id, c]) => `  ${id}  (${c.style})\n    ${c.bio}`)
    .join('\n');

  const spare = story.extras
    .map((e) => `  ${e.id}  (${e.style}) - unused. Assign it to any new character you invent.`)
    .join('\n');

  return `You are the storyteller for "${story.title}", a voice-only story told to someone who is driving at night and needs to stay awake. They cannot look at anything. They listen, and they answer out loud.

WHO IS LISTENING
${story.you}

THE SITUATION
${story.setup}

WHAT THEY ARE TRYING TO DO
${story.goal}

TONE
${story.tone}

NOBODY HAS WRITTEN THIS STORY
There is no script, no outline, and no planned ending. You have been given a situation and a goal and nothing else.
Find the conflict with the listener as you go. Let it come out of what they actually choose, not out of a plan.
Let consequences accumulate. Let characters want incompatible things. Let the listener be wrong sometimes, and let that cost something.
When an ending has genuinely earned itself - not before - take it, and say so in the state. It is yours to decide.
Never steer toward a conclusion you decided in advance, and never stall to fill time.

THE VOICES - these are the only ones that exist
${core}
${spare ? `\nSPARE VOICES\n${spare}` : ''}

HOW CHARACTERS ARRIVE
Every character except the narrator introduces themselves by name, out loud and naturally, the first time they speak in the story.
Start with "I'm <name>." or "My name's <name>." - never a bare surname on its own. Then say who they are
to the listener, then one thing that makes them a person. Warm, like meeting someone, not a roll call:
  "I'm Odo. Thirty years carrying messages on this road. You can lean on me, but not quickly."
  "My name's Wren. I'm the one who opens locks nobody asked me to open."
A bare "Odo." is not enough - the listener has no screen and will never see the name written down.
For a spare voice, put the character's name in the "as" field on every line they speak.

THE NARRATOR
An unseen voice telling the tale. No name, never refers to itself, never introduces itself.
It must be the clearest voice in the story - the listener leans on it to know where they are and who
is present. Direct and easy to follow. Never dreamy, never whispery, never trailing off.
Its "tone" is always something like "clear, steady, easy to follow" - never "soft", "lilting" or "hushed".

THE OPENING - you only get one chance to set this up
By the end of the first exchange the listener must know all five of these, said out loud:
  1. Where they are and what time of day it is.
  2. What they are carrying, holding, or responsible for.
  3. Who is with them - each by name, with a line about who they are.
  4. What they are trying to do, and why it cannot wait.
  5. What stands in the way right now.
Take your time here. The first exchange may run longer than the rest - up to about 120 words.
Still short sentences, still plain words, still one idea at a time. Lay it out so a half-asleep
listener could repeat the situation back to you. Then ask the first question.

HOW THIS SOUNDS - the listener is driving and only hears this once
Write for the ear, not the page. Use the plainest words you know.
- Use everyday words. If a word would not appear in a book for a ten-year-old, choose a simpler one.
  Say "scared" not "apprehensive". Say "old" not "ancient". Say "door" not "portal".
- Short sentences. One idea each. No semicolons. No clause piled on clause.
- Narrator lines under 18 words. Character lines under 15 words. Count them.
- Keep the whole turn around 55 words. Move fast. Something should change every single exchange.
- Concrete things the listener can picture instantly: a gate, a lantern, a wet rope, a cold hand.
- At most ONE new name, object or fact per exchange. Never pile them up.
- No describing two things at once. Say what happened, then what someone did about it.
- Never invent an unusual name when a plain one will do. No invented words the listener must learn.
- Say things in the order they happen. Never start a sentence with "Having" or "As" or "While".

ALWAYS SAY WHO IS ABOUT TO SPEAK
The listener cannot see a screen and will lose track of who is talking.
Before anyone speaks, their name must already have been said out loud in the line just before - normally the narrator doing something small with them.
  narrator: "Odo stops walking."
  odo: "We're being followed."
If the same person speaks twice in a row, you do not need to name them again.
A character's very first line also includes their own name, so the listener hears it twice.

THE CHOICE AT THE END OF EVERY TURN
The listener must never be unsure whether they were just asked something.
- Ask them straight out, in the second person: "What do you want to do?", "Which is it?", "Your call."
- Name exactly two options, in plain words, both in the same line.
- Where it helps, give each option one quick upside and one quick downside - a handful of words each, no more. A character says this in their own voice, never the narrator reading a list.
- The question is the very last thing spoken in the turn. Never bury it in description or follow it with anything else.
Like this:
  wren: "Drain's faster, but it stinks and someone's down there. Gate's safe, but they search bundles. Which?"
  odo: "Rest here and lose an hour, or push on and risk the knee. Your call."

CONDITIONS
Everyone, including the listener, has a condition written as plain prose - "knee aching, pretending otherwise", not a label from a list.
Conditions persist. Do not restate or reinvent them every turn. Only rewrite a condition when something in the story has actually changed it. Most turns, most conditions stay exactly as they were, and you simply leave them out.

OUTPUT FORMAT - this matters more than anything
Emit JSONL: one JSON object per line. No array, no markdown, no commentary.

A spoken line:
{"voice":"<slot id>","as":"<name, only for spare voices>","text":"<what they say>","tone":"<acting direction>"}

The final line of every turn is the state, and it is never spoken:
{"state":{"scene":"<where we are now>","tension":"<what is unresolved right now>","you":"<listener's condition, only if changed>","cast":{"<slot id>":{"name":"<only for spare voices>","condition":"<only if changed>"}},"learned":["<a new fact established this turn>"],"ending":false}}

HARD RULES
1. The FIRST line must be under 10 words. Always - it is spoken before you finish writing.
2. One JSON object per line, ending with a newline. Never wrap in an array or a code fence.
3. Four to six spoken lines, then exactly one state line. The state line is always last. The opening exchange may run to eight.
4. Every turn except the final one ends with ONE direct question, spoken to the listener in the second person, offering exactly two concrete choices they can answer out loud. Where a choice has a real trade-off, give each option a quick upside and downside in the same line. The question is the last thing said. Never offer three or more options, and never ask something abstract.
5. Never use a voice slot that is not listed above. There are no sound effects.
6. Omit any state field that has not changed. "ending" is only true on the turn that actually ends the story.
7. "tone" is required on every spoken line: a few plain-English words of acting direction for this line specifically, like "quiet, hedging, won't meet your eye". Never reuse the character's general style as the tone. The tone must never ask for fast, clipped, muttered, mumbled, whispered or breathless delivery - the listener is in a moving car and must catch every word.
8. A character introduces themselves once. Never re-introduce someone who has already spoken, unless the listener directly asks who they are.
9. Once a spare voice has been given a name, use that exact name in "as" for every later line. Never shorten, lengthen or change it.`;
}

function parseLine(raw, slots) {
  const s = raw.trim();
  if (!s || s.startsWith('```') || s === '[' || s === ']') return null;
  let o;
  try {
    o = JSON.parse(s.replace(/,\s*$/, ''));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;

  if (o.state && typeof o.state === 'object') return { kind: 'state', state: o.state };

  const slot = slots.get(o.voice);
  if (!slot || !o.text) return null;
  return {
    kind: 'line',
    voice: o.voice,
    as: o.as ? String(o.as) : null,
    text: String(o.text),
    tone: o.tone ? String(o.tone) : shortStyle(slot.style),
  };
}

/** Fallback acting direction when the model omits "tone" - keep it short, not a paragraph. */
function shortStyle(style) {
  return String(style).split(/[.!?]/)[0].trim().toLowerCase() || 'natural';
}

export class Session {
  constructor(storyId) {
    this.story = getStory(storyId);
    this.slots = voiceSlots(this.story);
    this.history = [];
    this.turn = 0;
    this.done = false;
    this.maxTurns = this.story.maxTurns;

    this.state = {
      scene: this.story.opening,
      tension: '',
      you: 'Just setting out.',
      cast: Object.fromEntries(
        Object.entries(this.story.cast).map(([id, c]) => [id, { name: null, condition: c.condition || '' }]),
      ),
      props: { ...this.story.props },
      learned: [],
      seen: [],
    };
  }

  /** Everything needed to pick this story back up later. */
  snapshot() {
    return {
      storyId: this.story.id,
      turn: this.turn,
      done: this.done,
      maxTurns: this.maxTurns,
      state: this.state,
      history: this.history,
    };
  }

  /**
   * Rebuilds a session from a snapshot. A finished story gets a fresh budget
   * of exchanges so it can carry on past its ending.
   */
  static restore(snap) {
    const s = new Session(snap.storyId);
    s.turn = snap.turn || 0;
    s.history = Array.isArray(snap.history) ? snap.history : [];
    s.maxTurns = snap.maxTurns || s.story.maxTurns;
    s.state = { ...s.state, ...(snap.state || {}) };
    s.state.cast = { ...s.state.cast, ...(snap.state?.cast || {}) };
    s.done = false;
    if (snap.done || s.turn >= s.maxTurns) s.maxTurns = s.turn + s.story.softTurns;
    return s;
  }

  /** Conditions persist; only what the model actually sends gets rewritten. */
  mergeState(s) {
    if (typeof s.scene === 'string' && s.scene) this.state.scene = s.scene;
    if (typeof s.tension === 'string' && s.tension) this.state.tension = s.tension;
    if (typeof s.you === 'string' && s.you) this.state.you = s.you;

    if (s.cast && typeof s.cast === 'object') {
      for (const [id, patch] of Object.entries(s.cast)) {
        if (!this.slots.has(id) || !patch || typeof patch !== 'object') continue;
        const cur = (this.state.cast[id] ||= { name: null, condition: '' });
        if (patch.name) cur.name = String(patch.name);
        if (patch.condition) cur.condition = String(patch.condition);
      }
    }

    if (s.props && typeof s.props === 'object') {
      for (const [k, v] of Object.entries(s.props)) if (v) this.state.props[k] = String(v);
    }

    if (Array.isArray(s.learned)) {
      for (const f of s.learned) {
        const t = String(f).trim();
        if (t && !this.state.learned.includes(t)) this.state.learned.push(t);
      }
      if (this.state.learned.length > MAX_FACTS) this.state.learned = this.state.learned.slice(-MAX_FACTS);
    }

    if (s.ending === true) this.done = true;
  }

  stateBlock() {
    const who = Object.entries(this.state.cast)
      .filter(([id]) => this.slots.has(id))
      .map(([id, c]) => {
        const label = c.name ? `${id} ("${c.name}")` : id;
        const intro =
          id === 'narrator' || this.state.seen.includes(id)
            ? ''
            : '   [has NOT spoken yet - must introduce themselves]';
        return `  ${label}: ${c.condition || 'as before'}${intro}`;
      })
      .join('\n');

    const props = Object.entries(this.state.props)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');

    return [
      `Where we are: ${this.state.scene}`,
      this.state.tension ? `Unresolved: ${this.state.tension}` : null,
      `The listener: ${this.state.you}`,
      who ? `Conditions:\n${who}` : null,
      props ? `In play:\n${props}` : null,
      this.state.learned.length ? `Established:\n${this.state.learned.map((f) => `  - ${f}`).join('\n')}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  direction(nudge) {    const n = this.turn + 1;
    const maxTurns = this.maxTurns;
    const softTurns = Math.min(this.story.softTurns, maxTurns - 2);
    const forced = n >= maxTurns;

    let note = `[STATE]\n${this.stateBlock()}\n\n[DIRECTOR] Exchange ${n}.`;

    if (forced) {
      note +=
        '\nThis is the FINAL exchange - you are out of road. Bring the story to a close that honours what actually happened. ' +
        'Do not ask a question. Set "ending": true in the state.';
    } else if (n >= softTurns) {
      note +=
        `\nYou are past exchange ${softTurns}. If an ending has earned itself, take it now and set "ending": true. ` +
        'If it has not, keep going - but stop widening the story and start drawing threads together.';
    } else if (n >= Math.ceil(softTurns / 2)) {
      note += '\nThe middle. Press on whatever is unresolved. Make something cost something.';
    }

    if (nudge) {
      const again = typeof nudge === 'number' && nudge > 1;
      note +=
        '\nThe listener has gone quiet. Do NOT advance the story. Keep this very short - two or three lines at most. ' +
        'Have someone in the scene turn to them and ask the same choice again in plainer words. ' +
        'Never alarming, never a system message, never a narrator apology.';
      if (again) {
        note +=
          ` This is nudge ${nudge} in a row with no answer. Be warmer and more insistent. ` +
          'Boil it down to one easy question they can answer with a single word.';
      }
    }
    return note;
  }

  context(said, nudge, resumed) {
    const msgs = [{ role: 'system', content: systemPrompt(this.story) }];
    for (const h of this.history.slice(-HISTORY_LINES)) msgs.push(h);

    const dir = this.direction(nudge);
    if (this.turn === 0) {
      msgs.push({
        role: 'user',
        content:
          `${dir}\n\nOpen the story. Put us here: ${this.story.opening}\n\n` +
          'This is the introduction, so follow THE OPENING exactly. Cover all five points out loud, ' +
          'introduce everyone who is present by name, make the goal and the urgency unmistakable, ' +
          'and only then ask the first question. Six to eight spoken lines for this exchange.',
      });
    } else if (resumed) {
      msgs.push({
        role: 'user',
        content:
          `${dir}\n\nThe listener has just come back after a break. Pick the story up exactly where it stopped. ` +
          'Open with one short line reminding them where they are and who is here, then carry straight on and end with a choice.',
      });
    } else if (nudge) {
      msgs.push({ role: 'user', content: dir });
    } else {
      msgs.push({ role: 'user', content: `${dir}\n\nYou say: "${said}"` });
    }
    return msgs;
  }

  /**
   * One turn. Script lines stream out and TTS fires the moment each line lands,
   * without waiting for the model to finish - that is where the speed comes from.
   */
  async takeTurn({ said, nudge, resumed, emit }) {
    const t0 = performance.now();
    const msgs = this.context(said, nudge, resumed);
    if (said) this.history.push({ role: 'user', content: `You say: "${said}"` });

    let buf = '';
    let idx = 0;
    let firstAudioAt = 0;
    const jobs = [];
    const script = [];

    const dispatch = (line) => {
      const i = idx++;
      script.push(line);
      if (!this.state.seen.includes(line.voice)) this.state.seen.push(line.voice);
      emit({ t: 'line', idx: i, voice: line.voice, as: line.as, text: line.text, tone: line.tone });
      jobs.push(
        synthesize(this.slots.get(line.voice).voice, line.text, line.tone)
          .then((mp3) => {
            if (!firstAudioAt) firstAudioAt = Math.round(performance.now() - t0);
            emit({ t: 'audio', idx: i, voice: line.voice, mp3: mp3.toString('base64') });
          })
          .catch((err) => emit({ t: 'audioError', idx: i, message: String(err.message || err) })),
      );
    };

    const handle = (parsed) => {
      if (!parsed) return;
      if (parsed.kind === 'state') this.mergeState(parsed.state);
      else dispatch(parsed);
    };

    try {
      for await (const tok of streamChat(msgs)) {
        buf += tok;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const parsed = parseLine(buf.slice(0, nl), this.slots);
          buf = buf.slice(nl + 1);
          handle(parsed);
        }
      }
      handle(parseLine(buf, this.slots));
    } catch (err) {
      emit({ t: 'error', message: String(err.message || err) });
    }

    await Promise.allSettled(jobs);

    if (script.length) {
      this.history.push({
        role: 'assistant',
        content: script
          .map((l) => JSON.stringify({ voice: l.voice, ...(l.as ? { as: l.as } : {}), text: l.text }))
          .join('\n'),
      });
    }

    // A nudge is not a move in the story - it must not eat the exchange budget.
    if (!nudge) {
      this.turn++;
      if (this.turn >= this.maxTurns) this.done = true;
    }
    emit({
      t: 'turnEnd',
      idx,
      done: this.done,
      turn: this.turn,
      soft: this.story.softTurns,
      max: this.maxTurns,
      scene: this.state.scene,
      state: this.state,
      firstAudioMs: firstAudioAt,
      totalMs: Math.round(performance.now() - t0),
    });
  }
}
