import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('transcripts');

const ensure = () => fs.mkdirSync(DIR, { recursive: true });

/**
 * Writes two files per session:
 *   <id>.md    readable log of everything said
 *   <id>.json  full snapshot so the story can be picked up again later
 */
export class Transcript {
  constructor(story, id = null) {
    ensure();
    this.story = story;
    this.id = id || `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${story.id}`;
    this.md = path.join(DIR, `${this.id}.md`);
    this.json = path.join(DIR, `${this.id}.json`);

    if (id && fs.existsSync(this.md)) this.write('\n---\n\n_...continued_\n');
    else this.write(`# ${story.title}\n\n_${story.you}_\n\n**Goal:** ${story.goal}\n\n---\n`);
  }

  write(s) {
    try {
      fs.appendFileSync(this.md, s);
    } catch { /* never let logging break the story */ }
  }

  said(text) {
    this.write(`\n**You:** ${text}\n`);
  }

  nudged() {
    this.write('\n_(you went quiet)_\n');
  }

  line({ voice, as, text, tone }) {
    this.write(`\n- **${as || voice}**${tone ? ` _(${tone})_` : ''}: ${text}\n`);
  }

  endTurn({ turn, firstAudioMs, totalMs, state, done }) {
    const conds = Object.entries(state.cast || {})
      .filter(([id, c]) => c.condition && state.seen?.includes(id))
      .map(([id, c]) => `  - ${c.name || id}: ${c.condition}`)
      .join('\n');
    this.write(
      `\n> _exchange ${turn} · first audio ${firstAudioMs}ms · total ${totalMs}ms_\n` +
      `> _scene: ${state.scene}_\n` +
      (state.you ? `\n**Conditions**\n  - you: ${state.you}\n${conds}\n` : '') +
      (done ? '\n---\n\n## The End\n' : '\n---\n'),
    );
    if (done && state.learned?.length) {
      this.write(`\n**Established along the way**\n${state.learned.map((f) => `  - ${f}`).join('\n')}\n`);
    }
  }

  /** Called after every turn so a crash never loses more than one exchange. */
  save(session) {
    try {
      const snap = session.snapshot();
      fs.writeFileSync(
        this.json,
        JSON.stringify({ id: this.id, title: this.story.title, savedAt: new Date().toISOString(), scene: snap.state.scene, ...snap }, null, 2),
      );
    } catch { /* ignore */ }
  }
}

/** Saved sessions, newest first, for the "carry on" list. */
export function listSaves() {
  ensure();
  const out = [];
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (!s.storyId || !s.turn) continue;
      out.push({
        id: s.id,
        storyId: s.storyId,
        title: s.title,
        turn: s.turn,
        done: !!s.done,
        scene: s.scene || '',
        savedAt: s.savedAt,
      });
    } catch { /* skip unreadable saves */ }
  }
  return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))).slice(0, 12);
}

export function loadSave(id) {
  if (!id || !/^[\w.-]+$/.test(id)) return null;
  const f = path.join(DIR, `${id}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}
