import type { Skill } from '../core/skill.js';
import { devTaskSkill } from './schema.js';
import { superviseTaskSkill } from './supervise.js';

/** Tasks written before skills existed carry no skill name; they are dev tasks. */
export const DEFAULT_SKILL_NAME = 'dev-task';

/**
 * Skills available to a store. The registry is the extension point for new
 * domains: a skill brings its own Σ schema, its own guard and its own procedure
 * P, so the runtime, the tools and the storage layer stay domain-neutral.
 */
export interface SkillRegistry {
  readonly defaultName: string;
  get(name: string): Skill | undefined;
  names(): string[];
  /** The default skill; always present. */
  default(): Skill;
}

export function createSkillRegistry(
  skills: readonly Skill[],
  defaultName: string = DEFAULT_SKILL_NAME,
): SkillRegistry {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const fallback = byName.get(defaultName);
  if (fallback === undefined) {
    throw new Error(
      `default skill "${defaultName}" is not in the registry (has: ${[...byName.keys()].join(', ') || 'nothing'})`,
    );
  }
  return {
    defaultName,
    get: (name) => byName.get(name),
    names: () => [...byName.keys()],
    default: () => fallback,
  };
}

/** Skills shipped with the runtime. */
export function builtinSkills(): readonly Skill[] {
  return [devTaskSkill(), superviseTaskSkill()];
}

export function builtinSkillRegistry(): SkillRegistry {
  return createSkillRegistry(builtinSkills(), DEFAULT_SKILL_NAME);
}
