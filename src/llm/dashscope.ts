import type { ProviderConfig } from '../config.js';
import type { CompletionOptions, LLMProvider, LLMResponse } from './provider.js';
import type { OpenAICompatibleSettings } from './openai-compatible.js';
import { completeOpenAICompatible } from './openai-compatible.js';

export class DashScopeProvider implements LLMProvider {
  readonly kind = 'dashscope';
  readonly model: string;
  private readonly settings: OpenAICompatibleSettings;

  constructor(config: ProviderConfig) {
    if (config.apiKey === undefined) {
      throw new Error('DashScope provider requires an apiKey (DASHSCOPE_API_KEY).');
    }
    this.model = config.model;
    this.settings = {
      kind: this.kind,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      model: config.model,
    };
  }

  complete(prompt: string, options?: CompletionOptions): Promise<LLMResponse> {
    return completeOpenAICompatible(this.settings, prompt, options);
  }
}
