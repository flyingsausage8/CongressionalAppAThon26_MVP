import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('content/stories');

/** Every starting point in content/stories, loaded once at boot. */
function loadAll() {
  const out = new Map();
  for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    const s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    s.id ||= path.basename(f, '.json');
    s.extras ||= [];
    s.props ||= {};
    s.softTurns ||= 12;
    s.maxTurns ||= s.softTurns + 8;
    out.set(s.id, s);
  }
  if (!out.size) throw new Error('no stories found in content/stories');
  return out;
}

export const stories = loadAll();
export const defaultStoryId = stories.has('the-last-egg') ? 'the-last-egg' : [...stories.keys()][0];

export function getStory(id) {
  return stories.get(id) || stories.get(defaultStoryId);
}

/** Short list for the picker. */
export function storyMenu() {
  return [...stories.values()].map((s) => ({
    id: s.id,
    title: s.title,
    blurb: s.blurb,
    you: s.you,
    goal: s.goal,
    cast: Object.keys(s.cast).length,
  }));
}

/** Every voice slot the model is allowed to use for this story. */
export function voiceSlots(story) {
  const slots = new Map();
  for (const [id, c] of Object.entries(story.cast)) {
    slots.set(id, { voice: c.voice, style: c.style, core: true });
  }
  for (const e of story.extras) {
    slots.set(e.id, { voice: e.voice, style: e.style, core: false });
  }
  return slots;
}
