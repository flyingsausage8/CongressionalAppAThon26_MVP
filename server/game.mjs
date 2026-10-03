import fs from 'node:fs';
import { streamChat, synthesize } from './ai.mjs';

const cast = JSON.parse(fs.readFileSync('content/cast.json', 'utf8'));
const story = JSON.parse(fs.readFileSync('content/story.json', 'utf8'));

const VOICES = Object.keys(cast);
const SFX = new Set(story.sfx);
const HISTORY_LINES = 18;

function systemPrompt() {
  const who = VOICES.map((k) => `- ${k} (${cast[k].style}) ${cast[k].bio}`).join('\n');
  return `You are the storyteller for "${story.title}", a voice-only story told to someone who is driving and needs to stay awake. They cannot look at a screen. They listen, and they answer out loud.

PREMISE
${story.premise}

YOUR GOAL
${story.goal}

THE CAST (these are the only voices that exist)
${who}

SOUND EFFECTS (the only ones available)
${[...SFX].join(', ')}

STORY RULES
${story.rules.map((r) => `- ${r}`).join('\n')}

OUTPUT FORMAT - this matters more than anything
Emit JSONL: one JSON object per line. No array. No markdown. No commentary.
Speech:  {"voice":"<${VOICES.join('|')}>","text":"<what they say>","tone":"<acting direction>"}
Sound:   {"voice":"sfx","name":"<${[...SFX].slice(0, 3).join('|')}|...>"}

HARD RULES
1. The FIRST line must be under 10 words. Always. It gets spoken before you finish writing.
2. One JSON object per line, ending with a newline. Never wrap in an array or code fence.
3. Write 3 to 5 lines per turn. Never more.
4. Keep every line under 30 words. Short lines sound alive; long ones drag.
5. "tone" is plain-English direction for the voice actor, e.g. "warm, teasing, unhurried".
6. End the turn with a question or a choice the listener can answer out loud.
7. Never use a voice or sfx name not listed above.`;
}

function parseLine(raw) {
  const s = raw.trim();
  if (!s || s.startsWith('```') || s === '[' || s === ']') return null;
  const body = s.replace(/,\s*$/, '');
  let o;
  try {
    o = JSON.parse(body);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || !o.voice) return null;
  if (o.voice === 'sfx') return SFX.has(o.name) ? { voice: 'sfx', name: o.name } : null;
  if (!cast[o.voice] || !o.text) return null;
  return { voice: o.voice, text: String(o.text), tone: o.tone ? String(o.tone) : cast[o.voice].style };
}

export class Session {
  constructor() {
    this.history = [];
    this.turn = 0;
  }

  context(said, nudge) {
    const msgs = [{ role: 'system', content: systemPrompt() }];
    for (const h of this.history.slice(-HISTORY_LINES)) msgs.push(h);

    if (this.turn === 0) {
      msgs.push({ role: 'user', content: `Begin the tale. Beat to hit: ${story.openingBeat}` });
    } else if (nudge) {
      msgs.push({
        role: 'user',
        content:
          'The listener has gone quiet. Gently pull them back in: a character asks them something ' +
          'directly, or something small and surprising happens. Keep it warm and inviting, never alarming.',
      });
    } else {
      msgs.push({ role: 'user', content: `You say: "${said}"` });
    }
    return msgs;
  }

  /**
   * Runs one turn. Streams script lines out and fires TTS the moment each line lands,
   * without waiting for the model to finish - that is where the speed comes from.
   */
  async takeTurn({ said, nudge, emit }) {
    const t0 = performance.now();
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

      if (line.voice === 'sfx') {
        emit({ t: 'sfx', idx: i, name: line.name });
        return;
      }
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

    emit({
      t: 'turnEnd',
      idx,
      firstAudioMs: firstAudioAt,
      totalMs: Math.round(performance.now() - t0),
    });
  }
}

export const castInfo = cast;
export const storyInfo = story;
