import { describe, expect, it } from 'vitest';
import { applyDotEnv, loadDotEnv, parseDotEnv, resolveProviderConfig } from '../src/config.js';

describe('resolveProviderConfig', () => {
  it('defaults to ollama with local model and base URL', () => {
    expect(resolveProviderConfig({})).toEqual({
      kind: 'ollama',
      model: 'qwen3.8:27b',
      baseUrl: 'http://localhost:11434',
    });
  });

  it('honors the global MODEL override', () => {
    const cfg = resolveProviderConfig({ PROVIDER: 'ollama', MODEL: 'llama3.1:8b' });
    expect(cfg.model).toBe('llama3.1:8b');
  });

  it('honors per-provider OLLAMA_MODEL / OLLAMA_BASE_URL and is case-insensitive', () => {
    const cfg = resolveProviderConfig({
      PROVIDER: 'OLLAMA',
      OLLAMA_MODEL: 'm1',
      OLLAMA_BASE_URL: 'http://gpu-box:11434',
    });
    expect(cfg.model).toBe('m1');
    expect(cfg.baseUrl).toBe('http://gpu-box:11434');
  });

  it('requires DASHSCOPE_API_KEY', () => {
    expect(() => resolveProviderConfig({ PROVIDER: 'dashscope' })).toThrow(/DASHSCOPE_API_KEY/);
  });

  it('builds a dashscope config with key and default endpoint', () => {
    const cfg = resolveProviderConfig({ PROVIDER: 'dashscope', DASHSCOPE_API_KEY: 'sk-test' });
    expect(cfg).toEqual({
      kind: 'dashscope',
      model: 'qwen-plus',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-test',
    });
  });

  it('builds an openrouter config honoring base URL override', () => {
    const cfg = resolveProviderConfig({
      PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_BASE_URL: 'https://proxy.test/api/v1',
      OPENROUTER_MODEL: 'qwen/qwen3-235b-a22b',
    });
    expect(cfg).toEqual({
      kind: 'openrouter',
      model: 'qwen/qwen3-235b-a22b',
      baseUrl: 'https://proxy.test/api/v1',
      apiKey: 'sk-or-test',
    });
  });

  it('rejects an unknown provider', () => {
    expect(() => resolveProviderConfig({ PROVIDER: 'anthropic' })).toThrow(/Unknown PROVIDER/);
  });
});

describe('parseDotEnv', () => {
  it('parses KEY=VALUE lines and skips comments, blanks, and malformed lines', () => {
    const content = [
      '# comment',
      '',
      'FOO=bar',
      'QUOTED="a b"',
      "SINGLE='c d'",
      'noequals',
      'EMPTY=',
    ].join('\n');
    expect(parseDotEnv(content)).toEqual({
      FOO: 'bar',
      QUOTED: 'a b',
      SINGLE: 'c d',
      EMPTY: '',
    });
  });
});

describe('applyDotEnv', () => {
  it('fills missing variables but never overrides existing ones', () => {
    const env: Record<string, string | undefined> = { EXISTING: 'keep' };
    applyDotEnv({ EXISTING: 'override', NEW: 'added' }, env);
    expect(env.EXISTING).toBe('keep');
    expect(env.NEW).toBe('added');
  });
});

describe('loadDotEnv', () => {
  it('returns an empty object when the file does not exist', () => {
    expect(loadDotEnv('./no-such-file.env')).toEqual({});
  });
});
