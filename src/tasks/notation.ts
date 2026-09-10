/**
 * How Σ values must be written. Σ is re-injected on every turn, so its size is a
 * recurring cost: `compact` trades grammar for characters, which is what keeps a
 * small-context local model inside its window on a long task.
 */
export const NOTATIONS = ['plain', 'compact'] as const;

export type Notation = (typeof NOTATIONS)[number];

export const DEFAULT_NOTATION: Notation = 'plain';

export function isNotation(value: unknown): value is Notation {
  return typeof value === 'string' && (NOTATIONS as readonly string[]).includes(value);
}

export const COMPACT_NOTATION_INSTRUCTIONS: string = `## Notation: compact (this task uses it)
Write every Σ value as compressed pseudocode. Characters are the budget, grammar is not.
- Drop articles and filler: "a", "an", "the", "we decided to", "it seems that".
- Symbols: \`->\` then / leads to, \`+\` add / and, \`-\` remove / without, \`=\` is, \`!\` important, \`?\` unknown, verify.
- One entry = one line. No paragraphs, no sentences over ~12 words.
- Verbatim, never compressed: file paths, identifiers, commands, error text, numbers, units.
- Readable abbreviations only: ctx, cfg, impl, verify, repro, dep, env.
- Never compress away a fact a later step needs (a constraint, a reason, a failing command).
  If Σ grows, delete finished work down to its outcome instead of writing tighter prose.
Example — good: \`car.gd drift: input -> slip -> grip lerp; verify godot --headless --check-only !\`
Example — bad: \`In this step we implemented the drifting behaviour for the car and we plan to verify it.\``;

/** Appendix to the procedure P for the task's notation; empty for plain prose. */
export function notationInstructions(notation: Notation): string {
  return notation === 'compact' ? COMPACT_NOTATION_INSTRUCTIONS : '';
}

/** One-line reminder for hosts that inject Σ without P (hooks, adapters). */
export function notationReminder(notation: Notation): string {
  if (notation !== 'compact') return '';
  return 'Σ uses compact notation: pseudocode, symbols (-> + - = ! ?), one line per entry, paths and commands verbatim.';
}
