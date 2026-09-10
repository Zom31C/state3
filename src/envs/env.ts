/**
 * Deterministic environment for skill evaluation.
 * The runtime calls observe() for O_t and step(action) to execute a_t.
 */
export interface Environment {
  /** Current observation O_t, rendered as text. */
  observe(): string;
  /** Executes the action. Invalid actions are the environment's concern (no-op, penalty, ...). */
  step(action: string): void;
  /** True once the episode ends early. */
  readonly done?: boolean;
}
