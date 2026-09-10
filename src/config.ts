import { existsSync, readFileSync } from 'node:fs';

export type ProviderKind = 'ollama' | 'dashscope' | 'openrouter';

export interface ProviderConfig {
  kind: ProviderKind;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

interface ProviderDefaults {
  model: string;
  baseUrl: string;
  apiKeyEnvKey?: string;
  baseUrlEnvKey: string;
  modelEnvKey: string;
}

const PROVIDER_DEFAULTS: Record<ProviderKind, ProviderDefaults> = {
  ollama: {
    model: 'qwen3.8:27b',
    baseUrl: 'http://localhost:11434',
    baseUrlEnvKey: 'OLLAMA_BASE_URL',
    modelEnvKey: 'OLLAMA_MODEL',
  },
  dashscope: {
    model: 'qwen-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnvKey: 'DASHSCOPE_API_KEY',
    baseUrlEnvKey: 'DASHSCOPE_BASE_URL',
    modelEnvKey: 'DASHSCOPE_MODEL',
  },
  openrouter: {
    model: 'qwen/qwen-2.5-72b-instruct',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvKey: 'OPENROUTER_API_KEY',
    baseUrlEnvKey: 'OPENROUTER_BASE_URL',
    modelEnvKey: 'OPENROUTER_MODEL',
  },
};

const PROVIDER_KINDS = Object.keys(PROVIDER_DEFAULTS) as ProviderKind[];

export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === '') continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadDotEnv(path = '.env'): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseDotEnv(readFileSync(path, 'utf8'));
}

/** Puts .env values into the target environment without overriding existing variables. */
export function applyDotEnv(
  vars: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [key, value] of Object.entries(vars)) {
    if (env[key] === undefined) env[key] = value;
  }
}

export function resolveProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const rawProvider = (env.PROVIDER ?? 'ollama').trim().toLowerCase();
  if (!PROVIDER_KINDS.includes(rawProvider as ProviderKind)) {
    throw new Error(
      `Unknown PROVIDER "${rawProvider}". Expected one of: ${PROVIDER_KINDS.join(', ')}`,
    );
  }
  const kind = rawProvider as ProviderKind;
  const defaults = PROVIDER_DEFAULTS[kind];

  const model = env.MODEL ?? env[defaults.modelEnvKey] ?? defaults.model;
  const baseUrl = env[defaults.baseUrlEnvKey] ?? defaults.baseUrl;
  const config: ProviderConfig = { kind, model, baseUrl };

  if (defaults.apiKeyEnvKey !== undefined) {
    const apiKey = env[defaults.apiKeyEnvKey];
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        `Provider "${kind}" requires the ${defaults.apiKeyEnvKey} environment variable.`,
      );
    }
    config.apiKey = apiKey;
  }
  return config;
}
