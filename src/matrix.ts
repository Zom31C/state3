import type { EpisodeDeps, EpisodeMetrics, RuntimeKind } from './episode.js';
import { runEpisode } from './episode.js';

export interface MatrixOptions {
  runtimes: readonly RuntimeKind[];
  horizons: readonly number[];
  seeds: readonly number[];
  maxRetries: number;
  memoryWindow?: number;
  summarizeEvery?: number;
}

export interface MatrixCell {
  runtime: RuntimeKind;
  horizon: number;
  seed: number;
  provider: string;
  model: string;
  metrics: EpisodeMetrics;
}

export interface MatrixSummaryRow {
  runtime: RuntimeKind;
  horizon: number;
  runs: number;
  avgAccuracy: number;
  avgPromptChars: number;
  totalTokens: number;
  invalidSteps: number;
}

export interface MatrixResult {
  options: MatrixOptions;
  cells: MatrixCell[];
  summary: MatrixSummaryRow[];
}

export async function runMatrix(options: MatrixOptions, deps?: EpisodeDeps): Promise<MatrixCell[]> {
  const cells: MatrixCell[] = [];
  for (const runtime of options.runtimes) {
    for (const horizon of options.horizons) {
      for (const seed of options.seeds) {
        const report = await runEpisode(
          {
            horizon,
            seed,
            runtime,
            maxRetries: options.maxRetries,
            ...(options.memoryWindow !== undefined ? { memoryWindow: options.memoryWindow } : {}),
            ...(options.summarizeEvery !== undefined
              ? { summarizeEvery: options.summarizeEvery }
              : {}),
          },
          deps,
        );
        cells.push({
          runtime,
          horizon,
          seed,
          provider: report.provider,
          model: report.model,
          metrics: report.metrics,
        });
      }
    }
  }
  return cells;
}

export function summarizeMatrix(cells: readonly MatrixCell[]): MatrixSummaryRow[] {
  const groups = new Map<string, MatrixCell[]>();
  for (const cell of cells) {
    const key = `${cell.runtime}|${cell.horizon}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [cell]);
    else bucket.push(cell);
  }

  const rows: MatrixSummaryRow[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0];
    if (first === undefined) continue;
    const accuracySum = bucket.reduce((acc, c) => acc + c.metrics.accuracy, 0);
    const promptCharsSum = bucket.reduce((acc, c) => acc + c.metrics.promptCharsAvg, 0);
    rows.push({
      runtime: first.runtime,
      horizon: first.horizon,
      runs: bucket.length,
      avgAccuracy: accuracySum / bucket.length,
      avgPromptChars: promptCharsSum / bucket.length,
      totalTokens: bucket.reduce((acc, c) => acc + c.metrics.tokens.total, 0),
      invalidSteps: bucket.reduce((acc, c) => acc + c.metrics.invalidSteps, 0),
    });
  }
  return rows;
}
