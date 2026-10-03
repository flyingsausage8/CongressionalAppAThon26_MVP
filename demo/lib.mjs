import fs from 'node:fs';

export function loadEnv(file = '.env') {
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    process.env[line.slice(0, i)] = line.slice(i + 1).trim();
  }
}

async function collect(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let firstByteAt = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstByteAt) firstByteAt = performance.now();
    chunks.push(value);
  }
  return { buf: Buffer.concat(chunks), firstByteAt: firstByteAt || performance.now() };
}

/** Azure Speech TTS. `inner` may contain SSML markup. */
export async function azureSpeech(voice, inner) {
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' ` +
    `xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='en-US'>` +
    `<voice name='${voice}'>${inner}</voice></speak>`;
  const res = await fetch(
    `https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      },
      body: ssml,
    },
  );
  if (!res.ok) throw new Error(`azure tts ${res.status}: ${await res.text()}`);
  return collect(res);
}

/** OpenAI gpt-4o-mini-tts. `instructions` is plain-English acting direction. */
export async function openaiTts(voice, text, instructions) {
  const res = await fetch(
    `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/gpt-4o-mini-tts/audio/speech` +
      `?api-version=2025-03-01-preview`,
    {
      method: 'POST',
      headers: { 'api-key': process.env.AZURE_OPENAI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        input: text,
        voice,
        response_format: 'mp3',
        ...(instructions ? { instructions } : {}),
      }),
    },
  );
  if (!res.ok) throw new Error(`openai tts ${res.status}: ${await res.text()}`);
  return collect(res);
}

/** Chat completion. Yields token deltas when stream=true, else returns full text. */
export async function chat(messages, { stream = false, maxTokens = 2000 } = {}) {
  const res = await fetch(
    `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}` +
      `/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`,
    {
      method: 'POST',
      headers: { 'api-key': process.env.AZURE_OPENAI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, max_completion_tokens: maxTokens, stream }),
    },
  );
  if (!res.ok) throw new Error(`chat ${res.status}: ${await res.text()}`);
  if (!stream) return (await res.json()).choices[0].message.content;
  return streamTokens(res);
}

async function* streamTokens(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      const delta = JSON.parse(data).choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}
