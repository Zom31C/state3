import type { ProviderConfig } from '../config.js';
import type { CompletionOptions, LLMProvider, LLMResponse } from './provider.js';
import { PAPER_SAMPLING } from './provider.js';

interface OllamaChatResponse {
  message?: { role?: string; content?: string };
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly kind = 'ollama';
  readonly model: string;
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<LLMResponse> {
    const body = {
      model: this.model,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
      options: {
        temperature: options.temperature ?? PAPER_SAMPLING.temperature,
        top_p: options.topP ?? PAPER_SAMPLING.topP,
        ...(options.maxTokens !== undefined ? { num_predict: options.maxTokens } : {}),
      },
      ...(options.jsonSchema !== undefined ? { format: options.jsonSchema } : {}),
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`ollama request failed (HTTP ${res.status}): ${rawText.slice(0, 500)}`);
    }

    let payload: OllamaChatResponse;
    try {
      payload = JSON.parse(rawText) as OllamaChatResponse;
    } catch {
      // Re-thrown below with the raw snippet attached.
      throw new Error(`ollama returned non-JSON response: ${rawText.slice(0, 500)}`);
    }

    if (payload.error !== undefined && payload.error !== '') {
      throw new Error(`ollama error: ${payload.error}`);
    }
    const text = payload.message?.content;
    if (text === undefined) {
      throw new Error(`ollama returned no completion text: ${rawText.slice(0, 500)}`);
    }

    const promptTokens = payload.prompt_eval_count ?? 0;
    const completionTokens = payload.eval_count ?? 0;
    return {
      text,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      model: payload.model ?? this.model,
    };
  }
}
