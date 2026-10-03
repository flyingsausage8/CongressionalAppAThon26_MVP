import fs from 'node:fs';
import { streamChat, synthesize } from './ai.mjs';

const cast = JSON.parse(fs.readFileSync('content/cast.json', 'utf8'));
const story = JSON.parse(fs.readFileSync('content/story.json', 'utf8'));

const VOICES = Object.keys(cast);
const HISTORY_LINES = 20;
const TARGET = story.targetTurns;

function systemPrompt() {
  const who = VOICES.map((k) => `- ${k}: ${cast[k].style}\n  ${cast[k].bio}`).join('\n');
  return `You are the storyteller for "${story.title}", a voice-only story told to someone who is driving and needs to stay awake. They cannot look at a screen. They listen, and they answer out loud.

PREMISE
${story.premise}

YOUR GOAL
${story.goal}

THE CAST (these are the only voices that exist)
${who}

STORY RULES
${story.rules.map((r) => `- ${r}`).join('\n')}

SHAPE
The whole story lasts about ${TARGET} exchanges and has a clear beginning, middle and end.
You will be told which act you are in and how many exchanges remain. Respect it.

OUTPUT FORMAT - this matters more than anything
Emit JSONL: one JSON object per line. No array. No markdown. No commentary.
{"voice":"<${VOICES.join('|')}>","text":"<what they say>","tone":"<acting direction>"}

HARD RULES
1. The FIRST line must be under 10 words. Always. It gets spoken before you finish writing.
2. One JSON object per line, ending with a newline. Never wrap in an array or code fence.
3. Write 3 to 4 lines per turn. Never more.
4. Keep every line under 28 words. Short lines sound alive; long ones drag.
5. "tone" is plain-English direction for the voice actor, e.g. "warm, teasing, unhurried".
6. End every turn except the last with a question or choice the listener can answer out loud.
7. Never use a voice that is not listed above. There are no sound effects.`;
}

function parseLine(raw) {
  const s = raw.trim();
  if (!s || s.startsWith('```') || s === '[' || s === ']') return null;
  let o;
  try {
    o = JSON.parse(s.replace(/,\s*$/, ''));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  if (!cast[o.voice] || !o.text) return null;
  return { voice: o.voice, text: String(o.text), tone: o.tone ? String(o.tone) : cast[o.voice].style };
}

/** Which act we are in, based on how many exchanges have happened. */
function actFor(turn) {
  const n = turn + 1;
  return story.acts.find((a) => n <= a.through) || story.acts[story.acts.length - 1];
}

export class Session {
  constructor() {
    this.history = [];
    this.turn = 0;
    this.done = false;
  }

  direction(nudge) {
    const n = this.turn + 1;
    const act = actFor(this.turn);
    const left = Math.max(0, TARGET - n);
    const isLast = n >= TARGET;

    let note = `[DIRECTOR] Exchange ${n} of ${TARGET}. Act: "${act.name}". ${act.aim}`;

    if (isLast) {
      note +=
        '\nThis is the FINAL exchange. Bring the story to a warm, satisfying close. ' +
        'Resolve the wolf. Let Grandma have the last word or close to it. ' +
        'Do NOT ask a question and do NOT offer a choice - end the tale.';
    } else if (left <= 2) {
      note += `\nOnly ${left} exchanges remain after this one. Start closing things down and head for the cottage.`;
    }

    if (nudge) {
      note +=
        '\nThe listener has gone quiet. Gently pull them back: have a character ask them something ' +
        'directly and warmly. Never alarming.';
    }
    return note;
  }

  context(said, nudge) {
    const msgs = [{ role: 'system', content: systemPrompt() }];
    for (const h of this.history.slice(-HISTORY_LINES)) msgs.push(h);

    const dir = this.direction(nudge);
    if (this.turn === 0) {
      msgs.push({ role: 'user', content: `${dir}\n\nBegin the tale. Beat to hit: ${story.openingBeat}` });
    } else if (nudge) {
      msgs.push({ role: 'user', content: dir });
    } else {
      msgs.push({ role: 'user', content: `${dir}\n\nYou say: "${said}"` });
    }
    return msgs;
  }

  /**
   * Runs one turn. Streams script lines out and fires TTS the moment each line lands,
   * without waiting for the model to finish - that is where the speed comes from.
   */
  async takeTurn({ said, nudge, emit }) {
    const t0 = performance.now();
    const isLast = this.turn + 1 >= TARGET;
    const msgs = this.context(said, nudge);
    if (said) this.history.push({ role: 'user', content: `You say: "${said}"` });

    let buf = '';
    let idx = 0;
    let firstAudioAt = 0;
    const jobs = [];
    const script = [];

    const dispatch = (line) => {
      const i = idx++;
      script.push(line);
      emit({ t: 'line', idx: i, ...line });
      jobs.push(
        synthesize(cast[line.voice].voice, line.text, line.tone)
          .then((mp3) => {
            if (!firstAudioAt) firstAudioAt = Math.round(performance.now() - t0);
            emit({ t: 'audio', idx: i, voice: line.voice, mp3: mp3.toString('base64') });
          })
          .catch((err) => emit({ t: 'audioError', idx: i, message: String(err.message || err) })),
      );
    };

    try {
      for await (const tok of streamChat(msgs)) {
        buf += tok;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = parseLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (line) dispatch(line);
        }
      }
      const tail = parseLine(buf);
      if (tail) dispatch(tail);
    } catch (err) {
      emit({ t: 'error', message: String(err.message || err) });
    }

    await Promise.allSettled(jobs);

    if (script.length) {
      this.history.push({
        role: 'assistant',
        content: script.map((l) => JSON.stringify(l)).join('\n'),
      });
    }
    this.turn++;
    if (isLast) this.done = true;

    emit({
      t: 'turnEnd',
      idx,
      done: this.done,
      turn: this.turn,
      total: TARGET,
      act: actFor(this.turn - 1).name,
      firstAudioMs: firstAudioAt,
      totalMs: Math.round(performance.now() - t0),
    });
  }
}

export const castInfo = cast;
export const storyInfo = story;
