import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyDotEnv, loadDotEnv } from './config.js';
import type { EpisodeReport, RuntimeKind, RunOptions } from './episode.js';
import { ALL_RUNTIMES, runEpisode } from './episode.js';
import type { MatrixOptions, MatrixResult, MatrixSummaryRow } from './matrix.js';
import { runMatrix, summarizeMatrix } from './matrix.js';
import { parseTaskArgs, runTaskCommand, taskHelpText } from './task-cli.js';

export type {
  EpisodeDeps,
  EpisodeMetrics,
  EpisodeReport,
  RuntimeKind,
  RunOptions,
} from './episode.js';
export { ALL_RUNTIMES, runEpisode } from './episode.js';
export type { TaskCliDeps, TaskCliOptions, TaskSubcommand } from './task-cli.js';
export { TASK_SUBCOMMANDS, parseTaskArgs, runTaskCommand, taskHelpText } from './task-cli.js';

function intArg(raw: string, flag: string, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${flag} expects an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

function intListArg(raw: string, flag: string, min: number): number[] {
  const parts = raw.split(',');
  if (parts.some((p) => p.trim() === '')) {
    throw new Error(`${flag} expects a comma-separated list of integers, got "${raw}"`);
  }
  return parts.map((p) => intArg(p.trim(), flag, min));
}

function runtimeKindArg(raw: string): RuntimeKind {
  const kind = ALL_RUNTIMES.find((k) => k === raw);
  if (kind === undefined) {
    throw new Error(`Unknown runtime "${raw}". Expected one of: ${ALL_RUNTIMES.join(', ')}`);
  }
  return kind;
}

export function parseArgs(argv: readonly string[]): RunOptions {
  const options: RunOptions = { horizon: 100, seed: 42, maxRetries: 3 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const takeValue = (name: string): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`Missing value for ${name}`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--horizon':
        options.horizon = intArg(takeValue(flag), flag, 1);
        break;
      case '--seed':
        options.seed = intArg(takeValue(flag), flag, 0);
        break;
      case '--max-retries':
        options.maxRetries = intArg(takeValue(flag), flag, 0);
        break;
      case '--runtime':
        options.runtime = runtimeKindArg(takeValue(flag));
        break;
      case '--horizons':
        options.horizons = intListArg(takeValue(flag), flag, 1);
        break;
      case '--seeds':
        options.seeds = intListArg(takeValue(flag), flag, 0);
        break;
      case '--memory-window':
        options.memoryWindow = intArg(takeValue(flag), flag, 1);
        break;
      case '--summarize-every':
        options.summarizeEvery = intArg(takeValue(flag), flag, 1);
        break;
      case '--structured':
        options.structured = true;
        break;
      case '--provider':
        options.provider = takeValue(flag);
        break;
      case '--model':
        options.model = takeValue(flag);
        break;
      case '--out':
        options.out = takeValue(flag);
        break;
      case '--quiet':
        options.quiet = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

function writeJsonOut(outPath: string, payload: unknown): void {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`results written to ${resolved}`);
}

function printProgress(report: EpisodeReport): void {
  let judgementIndex = 0;
  for (const record of report.steps) {
    if (!record.valid) {
      const categories = record.errors.map((e) => e.category).join(', ');
      console.log(`#${record.step} — invalid (${categories})`);
      continue;
    }
    const judgement = report.judgements[judgementIndex];
    judgementIndex += 1;
    const mark = judgement?.correct === true ? '✓' : '✗';
    console.log(`#${record.step} ${mark} ${record.action ?? ''}`);
    if (judgement !== undefined && !judgement.correct) {
      console.log(`   expected: ${judgement.expectedAction}`);
    }
  }
}

function printSummary(report: EpisodeReport): void {
  const m = report.metrics;
  console.log(
    `── skill=${report.skill} runtime=${report.runtime} horizon=${report.horizon} seed=${report.seed} ` +
      `provider=${report.provider} model=${report.model}`,
  );
  console.log(`accuracy: ${m.accuracy.toFixed(4)} (${m.correctActions}/${m.judged} judged)`);
  console.log(
    `valid steps: ${m.validSteps}  invalid: ${m.invalidSteps}  retries: ${m.totalRetries}  llm calls: ${m.llmCalls}`,
  );
  console.log(`prompt chars: total ${m.promptCharsTotal}, avg ${Math.round(m.promptCharsAvg)}`);
  console.log(
    `tokens: prompt ${m.tokens.prompt}, completion ${m.tokens.completion}, total ${m.tokens.total}`,
  );
  const errorModes = Object.entries(m.errorCounts);
  if (errorModes.length > 0) {
    console.log(`error modes: ${errorModes.map(([k, v]) => `${k}×${v}`).join(', ')}`);
  }
}

function printMatrixTable(rows: readonly MatrixSummaryRow[]): void {
  const header = [
    'runtime',
    'horizon',
    'runs',
    'accuracy',
    'avgPromptChars',
    'totalTokens',
    'invalidSteps',
  ];
  const table = rows.map((r) => [
    r.runtime,
    String(r.horizon),
    String(r.runs),
    r.avgAccuracy.toFixed(4),
    String(Math.round(r.avgPromptChars)),
    String(r.totalTokens),
    String(r.invalidSteps),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...table.map((row) => (row[i] ?? '').length)),
  );
  const render = (cells: readonly string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');
  console.log(render(header));
  for (const row of table) console.log(render(row));
}

function isMatrixMode(options: RunOptions): boolean {
  return options.horizons !== undefined || options.seeds !== undefined;
}

function matrixOptionsFrom(options: RunOptions): MatrixOptions {
  return {
    runtimes: options.runtime !== undefined ? [options.runtime] : ALL_RUNTIMES,
    horizons: options.horizons ?? [options.horizon],
    seeds: options.seeds ?? [options.seed],
    maxRetries: options.maxRetries,
    ...(options.memoryWindow !== undefined ? { memoryWindow: options.memoryWindow } : {}),
    ...(options.summarizeEvery !== undefined ? { summarizeEvery: options.summarizeEvery } : {}),
  };
}

/**
 * Top-level help. The task half is built by task-cli from its subcommand list and
 * flag table, so this text cannot drift away from what the parser accepts.
 */
export function usageText(): string {
  return [
    'state3 — SKILL.state runtime: long-horizon work on an external, validated state Σ',
    '',
    'Usage:',
    '  state3 task <subcommand>   read and write the task state Σ (full list below)',
    '  state3 <run flags>         run one episode, or a matrix of them, against a model',
    '',
    'Run flags (--horizon, --seed, --runtime, --provider, --model, --out, --quiet, …) are',
    'documented in README.md.',
    '',
    taskHelpText(),
  ].join('\n');
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(usageText());
    return;
  }

  if (argv[0] === 'task') {
    await runTaskCommand(parseTaskArgs(argv.slice(1)));
    return;
  }

  const options = parseArgs(argv);
  applyDotEnv(loadDotEnv());
  if (options.provider !== undefined) process.env.PROVIDER = options.provider;
  if (options.model !== undefined) process.env.MODEL = options.model;

  if (isMatrixMode(options)) {
    const matrixOptions = matrixOptionsFrom(options);
    const cells = await runMatrix(matrixOptions);
    const summary = summarizeMatrix(cells);
    printMatrixTable(summary);
    if (options.out !== undefined) {
      const payload: MatrixResult = { options: matrixOptions, cells, summary };
      writeJsonOut(options.out, payload);
    }
    return;
  }

  const report = await runEpisode(options);
  if (options.quiet !== true) printProgress(report);
  printSummary(report);
  if (options.out !== undefined) writeJsonOut(options.out, report);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
