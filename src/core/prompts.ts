import type { Skill } from './skill.js';
import type { StateDict } from './types.js';

/** One recorded ReAct step (O_t, R_t, a_t). */
export interface TranscriptEntry {
  observation: string;
  reasoning: string;
  action: string;
}

const REACT_FORMAT_BLOCK = `Observation: [observation]
Reasoning: [reasoning]
Action: [action]`;

const SKILL_STATE_FORMAT_BLOCK = `Respond exactly in the following format:
[reasoning]

\`\`\`json
{"state_patch": {...}, "action": "..."}
\`\`\`

- state_patch is a JSON dict whose keys are identical to the keys of the skill execution state, containing updated state to keep for future steps
- Set a key to null to delete it from the state
- action is a single valid action allowed in the skill environment`;

function joinBlocks(blocks: readonly string[]): string {
  return blocks.filter((block) => block !== '').join('\n\n');
}

function labeledBlock(label: string, body: string): string {
  return body === '' ? label : `${label}\n${body}`;
}

function reactTail(observation: string): string {
  return `Respond exactly in the following format:\n\n${REACT_FORMAT_BLOCK}\n\nObservation: ${observation}\nReasoning:`;
}

/** Renders transcript entries as plain text, separated by single blank lines. */
export function formatTranscript(history: readonly TranscriptEntry[]): string {
  return history
    .map(
      (entry) =>
        `Observation: ${entry.observation}\nReasoning: ${entry.reasoning}\nAction: ${entry.action}`,
    )
    .join('\n\n');
}

/** Serializes a state dictionary as single-line JSON without spaces. */
export function compactState(state: StateDict): string {
  return JSON.stringify(state);
}

/** A.1 — Prompt (ReAct) baseline: persona plus the full growing transcript. */
export function buildPromptRuntimePrompt(
  skill: Skill,
  history: readonly TranscriptEntry[],
  observation: string,
): string {
  return joinBlocks([
    `You are ${skill.instructions}`,
    'Execute the following task.',
    formatTranscript(history),
    reactTail(observation),
  ]);
}

/** A.2 — Memory baseline: NL summary of the past plus a short recent transcript window. */
export function buildMemoryRuntimePrompt(
  skill: Skill,
  memory: string,
  recent: readonly TranscriptEntry[],
  observation: string,
): string {
  return joinBlocks([
    `You are ${skill.instructions}`,
    'Execute the following task.',
    labeledBlock('Past summary:', memory),
    formatTranscript(recent),
    reactTail(observation),
  ]);
}

/** A.3 — Stateful baseline: state block plus the full growing transcript. */
export function buildStatefulRuntimePrompt(
  skill: Skill,
  state: StateDict,
  history: readonly TranscriptEntry[],
  observation: string,
): string {
  return joinBlocks([
    `You are ${skill.instructions}`,
    'Execute the following task.',
    labeledBlock('Current skill state:', compactState(state)),
    formatTranscript(history),
    reactTail(observation),
  ]);
}

/** A.4 — SKILL.state runtime prompt: compact execution state replaces the transcript. */
export function buildSkillStatePrompt(skill: Skill, state: StateDict, observation: string): string {
  return joinBlocks([
    `You are ${skill.instructions}`,
    'Execute the following task.',
    labeledBlock('Skill Execution State:', compactState(state)),
    labeledBlock('Latest Observation:', observation),
    SKILL_STATE_FORMAT_BLOCK,
  ]);
}
