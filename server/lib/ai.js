import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { dataPath, dataRoot } from './paths.js';

/**
 * OpenAI-compatible model settings.
 *
 * Environment wins so a host can keep the key out of the data volume. Otherwise
 * the key is stored in `data/ai.json`, written with mode 600 and never returned
 * to the browser. Works with OpenAI, GitHub Models, Groq, OpenRouter, Ollama's
 * /v1 endpoint and any other chat-completions provider.
 */

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
};

const file = () => dataPath('ai.json');

function readSaved() {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

export function aiConfig() {
  const saved = readSaved();
  const key = String(process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? saved.apiKey ?? '').trim();
  if (!key) return null;
  return {
    key,
    baseUrl: String(process.env.AI_BASE_URL ?? saved.baseUrl ?? DEFAULTS.baseUrl).trim().replace(/\/+$/, ''),
    model: String(process.env.AI_MODEL ?? saved.model ?? DEFAULTS.model).trim(),
  };
}

/** Safe status for the admin UI: never includes the key. */
export function aiStatus() {
  const saved = readSaved();
  const config = aiConfig();
  const envKey = Boolean(String(process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim());
  return {
    configured: Boolean(config),
    source: envKey ? 'env' : saved.apiKey ? 'file' : 'none',
    baseUrl: String(process.env.AI_BASE_URL ?? saved.baseUrl ?? DEFAULTS.baseUrl).trim(),
    model: String(process.env.AI_MODEL ?? saved.model ?? DEFAULTS.model).trim(),
  };
}

export function saveAiConfig({ apiKey = '', baseUrl = '', model = '' } = {}) {
  const saved = readSaved();
  const next = {
    ...saved,
    baseUrl: String(baseUrl || saved.baseUrl || DEFAULTS.baseUrl).trim(),
    model: String(model || saved.model || DEFAULTS.model).trim(),
  };
  const key = String(apiKey ?? '').trim();
  if (key) next.apiKey = key;
  mkdirSync(dataRoot(), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return aiStatus();
}
