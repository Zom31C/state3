import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeOpenAICompatible,
  type OpenAICompatibleSettings,
} from '../../src/llm/openai-compatible.js';

const settings: OpenAICompatibleSettings = {
  kind: 'test',
  baseUrl: 'https://example.test/v1',
  apiKey: 'sk-test',
  model: 'qwen-plus',
};

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

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const validPayload = {
  model: 'qwen-plus',
  choices: [{ message: { content: 'OK' } }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

describe('completeOpenAICompatible', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends paper sampling defaults, bearer auth, and parses usage', async () => {
    const calls = stubFetch(() => ok(validPayload));

    const res = await completeOpenAICompatible(settings, 'hello');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.test/v1/chat/completions');
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer sk-test' });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'qwen-plus',
      stream: false,
      temperature: 0,
      top_p: 1,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(body).not.toHaveProperty('max_tokens');

    expect(res).toEqual({
      text: 'OK',
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      model: 'qwen-plus',
    });
  });

  it('forwards explicit sampling options and maxTokens', async () => {
    const calls = stubFetch(() => ok(validPayload));

    await completeOpenAICompatible(settings, 'hello', {
      temperature: 0.5,
      topP: 0.9,
      maxTokens: 64,
    });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ temperature: 0.5, top_p: 0.9, max_tokens: 64 });
  });

  it('emits a json_schema response_format when a schema is provided', async () => {
    const calls = stubFetch(() => ok(validPayload));
    const jsonSchema = { type: 'object', properties: { a: { type: 'string' } } };

    await completeOpenAICompatible(settings, 'hello', { jsonSchema });

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      response_format?: {
        type?: string;
        json_schema?: { name?: string; schema?: unknown; strict?: boolean };
      };
    };
    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema?.name).toBe('structured_response');
    expect(body.response_format?.json_schema?.schema).toEqual(jsonSchema);
    expect(body.response_format?.json_schema?.strict).toBe(false);
  });

  it('omits response_format when no schema is provided', async () => {
    const calls = stubFetch(() => ok(validPayload));

    await completeOpenAICompatible(settings, 'hello');

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('response_format');
  });

  it('merges extra headers', async () => {
    const calls = stubFetch(() => ok(validPayload));

    await completeOpenAICompatible({ ...settings, extraHeaders: { 'X-Title': 'state3' } }, 'x');

    expect(calls[0]?.init.headers).toMatchObject({ 'X-Title': 'state3' });
  });

  it('throws with status and body snippet on HTTP error', async () => {
    stubFetch(() => new Response('{"error":"bad key"}', { status: 401 }));
    await expect(completeOpenAICompatible(settings, 'x')).rejects.toThrow(/HTTP 401/);
  });

  it('throws on non-JSON response', async () => {
    stubFetch(() => new Response('not json', { status: 200 }));
    await expect(completeOpenAICompatible(settings, 'x')).rejects.toThrow(/non-JSON/);
  });

  it('throws when the response carries no completion text', async () => {
    stubFetch(() => ok({ ...validPayload, choices: [] }));
    await expect(completeOpenAICompatible(settings, 'x')).rejects.toThrow(/no completion text/);
  });

  it('derives totalTokens when the server omits it', async () => {
    stubFetch(() =>
      ok({
        ...validPayload,
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      }),
    );
    const res = await completeOpenAICompatible(settings, 'x');
    expect(res.usage.totalTokens).toBe(7);
  });
});
