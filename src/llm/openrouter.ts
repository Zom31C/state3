import type { ProviderConfig } from '../config.js';
import type { CompletionOptions, LLMProvider, LLMResponse } from './provider.js';
import type { OpenAICompatibleSettings } from './openai-compatible.js';
import { completeOpenAICompatible } from './openai-compatible.js';

export class OpenRouterProvider implements LLMProvider {
  readonly kind = 'openrouter';
  readonly model: string;
  private readonly settings: OpenAICompatibleSettings;

  constructor(config: ProviderConfig) {
    if (config.apiKey === undefined) {
      throw new Error('OpenRouter provider requires an apiKey (OPENROUTER_API_KEY).');
    }
    this.model = config.model;
    this.settings = {
      kind: this.kind,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      model: config.model,
      extraHeaders: { 'X-Title': 'skillState' },
    };
  }

  complete(prompt: string, options?: CompletionOptions): Promise<LLMResponse> {
    return completeOpenAICompatible(this.settings, prompt, options);
  }
}
