// Thin wrappers over the two Azure AI calls the game makes.
const api = () => ({
  ep: process.env.AZURE_OPENAI_ENDPOINT,
  key: process.env.AZURE_OPENAI_KEY,
  dep: process.env.AZURE_OPENAI_DEPLOYMENT,
  ver: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
});

/** Streams assistant text token by token. */
export async function* streamChat(messages, { maxTokens = 1200 } = {}) {
  const { ep, key, dep, ver } = api();
  const res = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=${ver}`, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_completion_tokens: maxTokens, stream: true }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const data = dataLine.slice(6).trim();
      if (data === '[DONE]') return;
      let delta;
      try {
        delta = JSON.parse(data).choices?.[0]?.delta?.content;
      } catch {
        continue;
      }
      if (delta) yield delta;
    }
  }
}

/**
 * Text to speech with acting direction.
 * `instructions` is plain English, e.g. "quiet, suspicious, half-smiling".
 */
export async function synthesize(voice, text, instructions) {
  const { ep, key } = api();
  const res = await fetch(
    `${ep}/openai/deployments/gpt-4o-mini-tts/audio/speech?api-version=2025-03-01-preview`,
    {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        input: text,
        voice,
        response_format: 'mp3',
        ...(instructions ? { instructions } : {}),
      }),
    },
  );
  if (!res.ok) throw new Error(`tts ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Short-lived token so the browser can run speech-to-text without seeing the key. */
export async function speechToken() {
  const region = process.env.AZURE_SPEECH_REGION;
  const res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY, 'Content-Length': '0' },
  });
  if (!res.ok) throw new Error(`speech token ${res.status}: ${await res.text()}`);
  return { token: await res.text(), region };
}
