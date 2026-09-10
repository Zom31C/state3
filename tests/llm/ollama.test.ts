import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../src/llm/ollama.js';

const config = { kind: 'ollama' as const, model: 'qwen3.8:27b', baseUrl: 'http://localhost:11434' };

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(response: () => Response) {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response();
    }),
  );
  return calls;
}

const validPayload = {
  model: 'qwen3.8:27b',
  message: { role: 'assistant', content: 'OK' },
  prompt_eval_count: 10,
  eval_count: 3,
};

describe('OllamaProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to /api/chat with paper sampling defaults and parses usage', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify(validPayload), { status: 200 }));

    const provider = new OllamaProvider(config);
    const res = await provider.complete('hello');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:11434/api/chat');

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'qwen3.8:27b',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
      options: { temperature: 0, top_p: 1 },
    });

    expect(res).toEqual({
      text: 'OK',
      usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
      model: 'qwen3.8:27b',
    });
  });

  it('maps maxTokens to num_predict', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify(validPayload), { status: 200 }));

    await new OllamaProvider(config).complete('x', { maxTokens: 32 });

    const body = JSON.parse(String(calls[0]?.init.body)) as { options: Record<string, unknown> };
    expect(body.options).toMatchObject({ num_predict: 32 });
  });

  it('sends the JSON Schema as top-level format when provided', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify(validPayload), { status: 200 }));
    const jsonSchema = { type: 'object', properties: { a: { type: 'string' } } };

    await new OllamaProvider(config).complete('x', { jsonSchema });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.format).toEqual(jsonSchema);
  });

  it('omits format when no schema is provided', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify(validPayload), { status: 200 }));

    await new OllamaProvider(config).complete('x');

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('format');
  });

  it('strips trailing slashes from the base URL', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify(validPayload), { status: 200 }));

    await new OllamaProvider({ ...config, baseUrl: 'http://localhost:11434///' }).complete('x');

    expect(calls[0]?.url).toBe('http://localhost:11434/api/chat');
  });

  it('throws on an error field in the payload', async () => {
    stubFetch(
      () => new Response(JSON.stringify({ error: 'model "nope" not found' }), { status: 200 }),
    );
    await expect(new OllamaProvider(config).complete('x')).rejects.toThrow(/not found/);
  });

  it('throws with status on HTTP error', async () => {
    stubFetch(() => new Response('server gone', { status: 500 }));
    await expect(new OllamaProvider(config).complete('x')).rejects.toThrow(/HTTP 500/);
  });
});
