import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import {
  buildMemoryRuntimePrompt,
  buildPromptRuntimePrompt,
  buildState3Prompt,
  buildStatefulRuntimePrompt,
  compactState,
  formatTranscript,
  type TranscriptEntry,
} from '../../src/core/prompts.js';
import type { Skill } from '../../src/core/skill.js';
import type { StateDict } from '../../src/core/types.js';

const skill: Skill = {
  name: 'warehouse',
  instructions: 'a warehouse robot.',
  schema: z.record(z.string(), z.string()) as unknown as ZodType<StateDict>,
  initialState: { shelf_0: null, shelf_1: 'widget' },
};

const state: StateDict = { shelf_0: null, shelf_1: 'widget' };
const observation = 'You stand before shelf_0 and shelf_1.';

const entryA: TranscriptEntry = {
  observation: 'shelf_0 is empty',
  reasoning: 'the widget must be on shelf_1',
  action: 'move_to shelf_1',
};

const entryB: TranscriptEntry = {
  observation: 'shelf_1 holds a widget',
  reasoning: 'pick it up now',
  action: 'pick widget',
};

describe('buildState3Prompt (A.4)', () => {
  it('renders the full SKILL.state prompt verbatim', () => {
    const expected = `You are a warehouse robot.

Execute the following task.

Skill Execution State:
{"shelf_0":null,"shelf_1":"widget"}

Latest Observation:
You stand before shelf_0 and shelf_1.

Respond exactly in the following format:
[reasoning]

\`\`\`json
{"state_patch": {...}, "action": "..."}
\`\`\`

- state_patch is a JSON dict whose keys are identical to the keys of the skill execution state, containing updated state to keep for future steps
- Set a key to null to delete it from the state
- action is a single valid action allowed in the skill environment`;

    expect(buildState3Prompt(skill, state, observation)).toBe(expected);
  });

  it('serializes the state compactly right after the label', () => {
    const out = buildState3Prompt(skill, state, observation);

    expect(out).toContain('Skill Execution State:\n{"shelf_0":null,"shelf_1":"widget"}');
    expect(out).not.toContain('"shelf_0": null');
  });
});

describe('buildPromptRuntimePrompt (A.1)', () => {
  it('omits the transcript block for an empty history', () => {
    const out = buildPromptRuntimePrompt(skill, [], observation);

    expect(out).toBe(`You are a warehouse robot.

Execute the following task.

Respond exactly in the following format:

Observation: [observation]
Reasoning: [reasoning]
Action: [action]

Observation: You stand before shelf_0 and shelf_1.
Reasoning:`);
    expect(out).not.toContain('\n\n\n');
  });

  it('places the transcript between the task line and the format block', () => {
    const out = buildPromptRuntimePrompt(skill, [entryA, entryB], observation);

    expect(out).toContain(
      'Execute the following task.\n\n' +
        'Observation: shelf_0 is empty\nReasoning: the widget must be on shelf_1\nAction: move_to shelf_1\n\n' +
        'Observation: shelf_1 holds a widget\nReasoning: pick it up now\nAction: pick widget\n\n' +
        'Respond exactly in the following format:',
    );
    expect(out).not.toContain('\n\n\n');
  });
});

describe('buildMemoryRuntimePrompt (A.2)', () => {
  it('puts the memory right after "Past summary:" and the recent transcript after it', () => {
    const out = buildMemoryRuntimePrompt(skill, 'The widget is on shelf_1.', [entryB], observation);

    expect(out).toContain(
      'Execute the following task.\n\nPast summary:\nThe widget is on shelf_1.\n\n' +
        'Observation: shelf_1 holds a widget\nReasoning: pick it up now\nAction: pick widget\n\n' +
        'Respond exactly in the following format:',
    );
    expect(out).not.toContain('\n\n\n');
  });

  it('renders no blank-line artifacts when the recent transcript is empty', () => {
    const out = buildMemoryRuntimePrompt(skill, 'The widget is on shelf_1.', [], observation);

    expect(out).toBe(`You are a warehouse robot.

Execute the following task.

Past summary:
The widget is on shelf_1.

Respond exactly in the following format:

Observation: [observation]
Reasoning: [reasoning]
Action: [action]

Observation: You stand before shelf_0 and shelf_1.
Reasoning:`);
  });
});

describe('buildStatefulRuntimePrompt (A.3)', () => {
  it('puts the compact state right after "Current skill state:" and the transcript after it', () => {
    const out = buildStatefulRuntimePrompt(skill, state, [entryA, entryB], observation);

    expect(out).toContain(
      'Current skill state:\n{"shelf_0":null,"shelf_1":"widget"}\n\n' +
        'Observation: shelf_0 is empty\nReasoning: the widget must be on shelf_1\nAction: move_to shelf_1\n\n' +
        'Observation: shelf_1 holds a widget\nReasoning: pick it up now\nAction: pick widget\n\n' +
        'Respond exactly in the following format:',
    );
    expect(out).not.toContain('\n\n\n');
  });

  it('omits the transcript block for an empty history', () => {
    const out = buildStatefulRuntimePrompt(skill, state, [], observation);

    expect(out).toContain(
      'Current skill state:\n{"shelf_0":null,"shelf_1":"widget"}\n\n' +
        'Respond exactly in the following format:',
    );
    expect(out).not.toContain('\n\n\n');
  });
});

describe('compactState', () => {
  it('serializes a state dict as single-line JSON without spaces', () => {
    expect(compactState({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });
});

describe('formatTranscript', () => {
  it('returns an empty string for an empty history', () => {
    expect(formatTranscript([])).toBe('');
  });

  it('renders a single entry exactly', () => {
    expect(formatTranscript([entryA])).toBe(
      'Observation: shelf_0 is empty\nReasoning: the widget must be on shelf_1\nAction: move_to shelf_1',
    );
  });

  it('joins two entries with a single blank line', () => {
    expect(formatTranscript([entryA, entryB])).toBe(
      `${formatTranscript([entryA])}\n\n${formatTranscript([entryB])}`,
    );
  });
});
