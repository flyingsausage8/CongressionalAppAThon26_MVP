import fs from 'node:fs';

/** Loads .env into process.env. Tolerates CRLF and comments. */
export function loadEnv(file = '.env') {
  if (!fs.existsSync(file)) throw new Error(`missing ${file} - copy .env.example and fill it in`);
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    process.env[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const need = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`.env is missing: ${missing.join(', ')}`);
}
