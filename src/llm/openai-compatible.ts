import type { CompletionOptions, LLMResponse, TokenUsage } from './provider.js';
import { PAPER_SAMPLING } from './provider.js';

export interface OpenAICompatibleSettings {
  kind: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Extra headers merged into every request (e.g. OpenRouter attribution). */
  extraHeaders?: Record<string, string>;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export async function completeOpenAICompatible(
  settings: OpenAICompatibleSettings,
  prompt: string,
  options: CompletionOptions = {},
): Promise<LLMResponse> {
  const body = {
    model: settings.model,
    stream: false,
    messages: [{ role: 'user', content: prompt }],
    temperature: options.temperature ?? PAPER_SAMPLING.temperature,
    top_p: options.topP ?? PAPER_SAMPLING.topP,
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.jsonSchema !== undefined
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'structured_response',
              schema: options.jsonSchema,
              strict: false,
            },
          },
        }
      : {}),
  };

  const res = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`,
      ...settings.extraHeaders,
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(
      `${settings.kind} request failed (HTTP ${res.status}): ${rawText.slice(0, 500)}`,
    );
  }

  let payload: ChatCompletionResponse;
  try {
    payload = JSON.parse(rawText) as ChatCompletionResponse;
  } catch {
    // Re-thrown below with the raw snippet attached.
    throw new Error(`${settings.kind} returned non-JSON response: ${rawText.slice(0, 500)}`);
  }

  const text = payload.choices?.[0]?.message?.content;
  if (text === undefined || text === null) {
    throw new Error(`${settings.kind} returned no completion text: ${rawText.slice(0, 500)}`);
  }

  return {
    text,
    usage: parseUsage(payload.usage),
    model: payload.model ?? settings.model,
  };
}

function parseUsage(usage: ChatCompletionResponse['usage']): TokenUsage {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
  };
}
