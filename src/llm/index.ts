import type { ProviderConfig } from '../config.js';
import type { LLMProvider } from './provider.js';
import { DashScopeProvider } from './dashscope.js';
import { OllamaProvider } from './ollama.js';
import { OpenRouterProvider } from './openrouter.js';

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.kind) {
    case 'dashscope':
      return new DashScopeProvider(config);
    case 'openrouter':
      return new OpenRouterProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    default: {
      const exhaustive: never = config.kind;
      throw new Error(`Unknown provider kind: ${String(exhaustive)}`);
    }
  }
}

export type { CompletionOptions, LLMProvider, LLMResponse, TokenUsage } from './provider.js';
export { PAPER_SAMPLING } from './provider.js';
