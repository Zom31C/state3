export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionOptions {
  /** Sampling temperature. Paper default: 0.0 (deterministic reproducibility). */
  temperature?: number;
  /** Nucleus sampling mass. Paper default: 1.0. */
  topP?: number;
  /** Hard cap on generated tokens (maps to max_tokens / num_predict). */
  maxTokens?: number;
  /** Optional JSON Schema for provider-native structured output (constrained decoding). */
  jsonSchema?: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
  usage: TokenUsage;
  /** Model that actually produced the completion, as reported by the server. */
  model: string;
}

export interface LLMProvider {
  readonly kind: string;
  readonly model: string;
  complete(prompt: string, options?: CompletionOptions): Promise<LLMResponse>;
}

/** Decoding parameters fixed by the paper (arXiv:2608.26263) for all runs. */
export const PAPER_SAMPLING: Readonly<Pick<CompletionOptions, 'temperature' | 'topP'>> = {
  temperature: 0,
  topP: 1,
};
