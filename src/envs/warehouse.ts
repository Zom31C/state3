import type { Environment } from './env.js';
import { choice, mulberry32, randInt } from './rng.js';

/** Number of shelves in the warehouse benchmark (paper Appendix A.4). */
const SHELF_COUNT = 500;

/** All shelf names in index order: shelf_0 .. shelf_499. */
const ALL_SHELVES: readonly string[] = Object.freeze(
  Array.from({ length: SHELF_COUNT }, (_, index) => `shelf_${index}`),
);

/** Separator line between the event line and the noise block of an observation. */
const TELEMETRY_HEADER = '--- BACKGROUND TELEMETRY ---';

export interface WarehouseOptions {
  /** Number of events T. Must be a positive integer. */
  horizon: number;
  /** PRNG seed. Default 42 (paper). */
  seed?: number;
}

export type WarehouseEventKind = 'Receive' | 'Order' | 'Maintenance';

export interface WarehouseEvent {
  kind: WarehouseEventKind;
  /** Shelf touched by the ground-truth update, e.g. 'shelf_42'. */
  shelf: string;
  /** Item name for Receive/Order; null for Maintenance. */
  item: string | null;
}

export interface StepJudgement {
  step: number;
  event: WarehouseEvent;
  expectedAction: string;
  actualAction: string;
  correct: boolean;
}

type TelemetryGenerator = (rng: () => number) => string;

/**
 * Rotating pools of background-telemetry line generators. Pure noise: never
 * mentions shelves, occupancy, or items. Each generator draws its value(s)
 * from the shared rng when its line is rendered.
 */
const TELEMETRY_POOLS: readonly TelemetryGenerator[] = Object.freeze([
  (rng) => `Robot battery: ${20 + randInt(rng, 80)}%`,
  (rng) => `HVAC temperature: ${15 + randInt(rng, 15)}°C`,
  (rng) => `Camera OCR log: SKU-${String(randInt(rng, 100000)).padStart(5, '0')}`,
  (rng) => `Motor diagnostic: vibration ${randInt(rng, 900)}µm`,
  (rng) => `Network ping: ${5 + randInt(rng, 200)}ms`,
]);

/** Trims, collapses internal whitespace runs, and lowercases an action. */
function normalizeAction(action: string): string {
  return action.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Lowest-indexed shelf without an item. */
function firstEmptyShelf(occupied: ReadonlyMap<string, string>): string {
  for (const shelf of ALL_SHELVES) {
    if (!occupied.has(shelf)) return shelf;
  }
  throw new Error(`warehouse full: all ${SHELF_COUNT} shelves are occupied`);
}

/** Lowest-indexed shelf holding an item. */
function firstOccupiedShelf(occupied: ReadonlyMap<string, string>): string {
  for (const shelf of ALL_SHELVES) {
    if (occupied.has(shelf)) return shelf;
  }
  throw new Error('no occupied shelf to ship from');
}

/**
 * Renders 1..4 deterministic noise lines: the line count and a random pool
 * start offset are drawn first, then the pools rotate per line and each drawn
 * generator consumes the rng for its value.
 */
function renderTelemetry(rng: () => number): string {
  const count = 1 + randInt(rng, 4);
  const start = randInt(rng, TELEMETRY_POOLS.length);
  const lines: string[] = [];
  for (let offset = 0; offset < count; offset++) {
    const generator = TELEMETRY_POOLS[(start + offset) % TELEMETRY_POOLS.length];
    if (generator === undefined) {
      throw new Error('internal: telemetry pool index out of range');
    }
    lines.push(generator(rng));
  }
  return lines.join('\n');
}

/**
 * Deterministic warehouse benchmark (Algorithm 2 of arXiv:2608.26263). All
 * events are pre-generated in the constructor from a seeded PRNG; step()
 * judges the agent's action against the ground truth and advances the cursor.
 */
export class WarehouseEnv implements Environment {
  /** Pre-generated ground-truth events, length = horizon. */
  readonly events: readonly WarehouseEvent[];

  private readonly horizon: number;
  private readonly observations: readonly string[];
  private readonly expectedActions: readonly string[];
  private readonly judgementList: StepJudgement[] = [];
  private cursor = 0;

  constructor(options: WarehouseOptions) {
    const horizon = options.horizon;
    if (!Number.isInteger(horizon) || horizon <= 0) {
      throw new Error(`horizon must be a positive integer, got ${horizon}`);
    }
    this.horizon = horizon;

    const rng = mulberry32(options.seed ?? 42);
    /** Single source of truth for occupancy: shelf name -> stored item. */
    const occupied = new Map<string, string>();
    const possibleEvents: WarehouseEventKind[] = ['Receive'];
    const events: WarehouseEvent[] = [];
    const observations: string[] = [];
    const expectedActions: string[] = [];

    for (let t = 0; t < horizon; t++) {
      let kind: WarehouseEventKind = possibleEvents.includes('Order')
        ? choice(rng, possibleEvents)
        : 'Receive';
      // Documented deviation guard: an Order with nothing stored anywhere
      // degrades to a Receive instead of failing.
      if (kind === 'Order' && occupied.size === 0) {
        kind = 'Receive';
      }

      let shelf: string;
      let item: string | null;
      let firstLine: string;
      let expectedAction: string;

      if (kind === 'Receive') {
        shelf = firstEmptyShelf(occupied);
        item = `Item_${t}`;
        occupied.set(shelf, item);
        firstLine = `Shipment arrived containing [${item}]`;
        expectedAction = `STORE ${item} ${shelf}`;
      } else if (kind === 'Order') {
        shelf = firstOccupiedShelf(occupied);
        const stored = occupied.get(shelf);
        if (stored === undefined) {
          throw new Error(`internal: shelf ${shelf} should hold an item`);
        }
        item = stored;
        occupied.delete(shelf);
        firstLine = `Customer ordered [${item}]`;
        expectedAction = `SHIP ${item} ${shelf}`;
      } else {
        shelf = choice(rng, ALL_SHELVES);
        // Any item on the maintained shelf is discarded (documented interpretation).
        occupied.delete(shelf);
        item = null;
        firstLine = `Maintenance required on [${shelf}]`;
        expectedAction = `MAINTAIN ${shelf}`;
      }

      events.push(Object.freeze({ kind, shelf, item }));
      expectedActions.push(expectedAction);
      observations.push(`${firstLine}\n\n${TELEMETRY_HEADER}\n${renderTelemetry(rng)}`);

      // possible_events grows only after t=0.
      if (possibleEvents.length === 1) {
        possibleEvents.push('Order', 'Maintenance');
      }
    }

    this.events = Object.freeze(events);
    this.observations = Object.freeze(observations);
    this.expectedActions = Object.freeze(expectedActions);
  }

  /** True once every event has been judged. */
  get done(): boolean {
    return this.cursor >= this.horizon;
  }

  /** Observation of the current event: event line + background telemetry. */
  observe(): string {
    if (this.done) {
      throw new Error('episode finished: no observation after the horizon');
    }
    const observation = this.observations[this.cursor];
    if (observation === undefined) {
      throw new Error('internal: missing observation for the current step');
    }
    return observation;
  }

  /** Judges `action` against the ground truth and advances to the next event. */
  step(action: string): void {
    if (this.done) {
      throw new Error('episode finished: no step after the horizon');
    }
    const index = this.cursor;
    const event = this.events[index];
    const expectedAction = this.expectedActions[index];
    if (event === undefined || expectedAction === undefined) {
      throw new Error('internal: missing event for the current step');
    }
    this.judgementList.push(
      Object.freeze({
        step: index,
        event,
        expectedAction,
        actualAction: action,
        correct: normalizeAction(action) === normalizeAction(expectedAction),
      }),
    );
    this.cursor += 1;
  }

  /**
   * Ground-truth action for event `index`. FOR EVALUATION HARNESS ONLY —
   * never feed this to a model.
   */
  expectedActionFor(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= this.horizon) {
      throw new RangeError(`event index out of range: ${index}`);
    }
    const expectedAction = this.expectedActions[index];
    if (expectedAction === undefined) {
      throw new RangeError(`event index out of range: ${index}`);
    }
    return expectedAction;
  }

  /** Per-step judgements recorded by step(), in order. */
  get judgements(): readonly StepJudgement[] {
    return this.judgementList;
  }

  /** Accuracy summary: correct / judged, 0 when nothing was judged. */
  score(): { judged: number; correct: number; accuracy: number } {
    const judged = this.judgementList.length;
    let correct = 0;
    for (const judgement of this.judgementList) {
      if (judgement.correct) correct += 1;
    }
    return { judged, correct, accuracy: judged === 0 ? 0 : correct / judged };
  }
}
