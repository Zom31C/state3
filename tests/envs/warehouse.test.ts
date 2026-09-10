import { describe, expect, it } from 'vitest';
import type { Environment } from '../../src/envs/env.js';
import { choice, mulberry32, randInt } from '../../src/envs/rng.js';
import { WarehouseEnv } from '../../src/envs/warehouse.js';
import type { WarehouseEvent } from '../../src/envs/warehouse.js';
import { WAREHOUSE_SHELF_COUNT } from '../../src/skills/warehouse.js';

const TELEMETRY_HEADER = '--- BACKGROUND TELEMETRY ---';

const SHELF_NAMES: readonly string[] = Array.from(
  { length: WAREHOUSE_SHELF_COUNT },
  (_, index) => `shelf_${index}`,
);

interface SimulationCounts {
  receiveCount: number;
  orderCount: number;
  maintenanceCount: number;
  maintenanceOnOccupied: number;
}

/**
 * Re-simulates the ground truth over a pre-generated event list, asserting
 * every generation rule: Receive fills the lowest-indexed empty shelf with
 * Item_<t>, Order ships the item of the lowest-indexed occupied shelf, and
 * Maintenance discards whatever its shelf held.
 */
function simulate(events: readonly WarehouseEvent[]): SimulationCounts {
  const occupied = new Map<string, string>();
  const counts: SimulationCounts = {
    receiveCount: 0,
    orderCount: 0,
    maintenanceCount: 0,
    maintenanceOnOccupied: 0,
  };

  events.forEach((event, t) => {
    expect(SHELF_NAMES).toContain(event.shelf);
    if (event.kind === 'Receive') {
      counts.receiveCount += 1;
      expect(event.item).toBe(`Item_${t}`);
      expect(occupied.has(event.shelf)).toBe(false);
      expect(event.shelf).toBe(SHELF_NAMES.find((shelf) => !occupied.has(shelf)));
      occupied.set(event.shelf, event.item ?? '');
    } else if (event.kind === 'Order') {
      counts.orderCount += 1;
      expect(event.item).not.toBeNull();
      expect(occupied.has(event.shelf)).toBe(true);
      expect(occupied.get(event.shelf)).toBe(event.item);
      expect(event.shelf).toBe(SHELF_NAMES.find((shelf) => occupied.has(shelf)));
      occupied.delete(event.shelf);
    } else {
      counts.maintenanceCount += 1;
      expect(event.item).toBeNull();
      if (occupied.has(event.shelf)) counts.maintenanceOnOccupied += 1;
      occupied.delete(event.shelf);
    }
  });

  return counts;
}

/** Splits an observation into its event line and its telemetry noise lines. */
function splitObservation(observation: string): { firstLine: string; noiseLines: string[] } {
  const separator = `\n\n${TELEMETRY_HEADER}\n`;
  const index = observation.indexOf(separator);
  expect(index).toBeGreaterThan(0);
  return {
    firstLine: observation.slice(0, index),
    noiseLines: observation.slice(index + separator.length).split('\n'),
  };
}

describe('rng utilities', () => {
  it('mulberry32 produces the same stream for the same seed, all values in [0, 1)', () => {
    const draw = (seed: number) => {
      const rng = mulberry32(seed);
      return Array.from({ length: 100 }, () => rng());
    };
    expect(draw(42)).toEqual(draw(42));
    for (const value of draw(42)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('mulberry32 produces different streams for different seeds', () => {
    expect(draw1(42)).not.toBe(draw1(43));
    expect(draw1(0)).not.toBe(draw1(1));

    function draw1(seed: number): number {
      return mulberry32(seed)();
    }
  });

  it('choice throws on an empty array and picks deterministically from a non-empty one', () => {
    expect(() => choice(mulberry32(1), [])).toThrow(/empty/);
    const items = ['a', 'b', 'c'] as const;
    const picks = (seed: number) => {
      const rng = mulberry32(seed);
      return Array.from({ length: 10 }, () => choice(rng, items));
    };
    expect(picks(7)).toEqual(picks(7));
    for (const pick of picks(7)) {
      expect(items).toContain(pick);
    }
  });

  it('randInt throws unless n is a positive integer', () => {
    expect(() => randInt(mulberry32(1), 0)).toThrow(/positive integer/);
    expect(() => randInt(mulberry32(1), -3)).toThrow(/positive integer/);
    expect(() => randInt(mulberry32(1), 2.5)).toThrow(/positive integer/);
  });

  it('randInt stays within [0, n) and covers the whole range', () => {
    const rng = mulberry32(42);
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const value = randInt(rng, 4);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(4);
      seen.add(value);
    }
    expect(seen.size).toBe(4);
  });
});

describe('WarehouseEnv event generation', () => {
  it('rejects a horizon that is not a positive integer', () => {
    expect(() => new WarehouseEnv({ horizon: 0 })).toThrow(/positive integer/);
    expect(() => new WarehouseEnv({ horizon: -5 })).toThrow(/positive integer/);
    expect(() => new WarehouseEnv({ horizon: 2.5 })).toThrow(/positive integer/);
    expect(() => new WarehouseEnv({ horizon: Number.NaN })).toThrow(/positive integer/);
  });

  it('pre-generates exactly horizon events', () => {
    const env = new WarehouseEnv({ horizon: 200, seed: 42 });
    expect(env.events).toHaveLength(200);
  });

  it('always starts at t=0 with a Receive of Item_0 into shelf_0, for any seed', () => {
    for (const seed of [0, 1, 7, 42, 99, 12345]) {
      const env = new WarehouseEnv({ horizon: 10, seed });
      expect(env.events[0]).toEqual({ kind: 'Receive', shelf: 'shelf_0', item: 'Item_0' });
    }
  });

  it('unlocks Order and Maintenance only after t=0', () => {
    // possible_events is ['Receive'] at t=0 and grows to all three kinds
    // afterwards, so across seeds every kind must already show up at t=1.
    const kindsAtT1 = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const env = new WarehouseEnv({ horizon: 2, seed });
      kindsAtT1.add(env.events[1]?.kind ?? '');
    }
    expect(kindsAtT1.has('Receive')).toBe(true);
    expect(kindsAtT1.has('Order')).toBe(true);
    expect(kindsAtT1.has('Maintenance')).toBe(true);
  });

  it('generates a consistent 200-step episode with all three kinds for seed 42', () => {
    const env = new WarehouseEnv({ horizon: 200, seed: 42 });
    const counts = simulate(env.events);
    expect(counts.receiveCount).toBeGreaterThan(0);
    expect(counts.orderCount).toBeGreaterThan(0);
    expect(counts.maintenanceCount).toBeGreaterThan(0);
  });

  it('lets maintenance hit an occupied shelf and empty it', () => {
    // Maintenance targets are drawn uniformly over all 500 shelves while
    // occupancy stays low, so the seed-42 stream at horizon 200 happens to
    // contain no hit; the same seed demonstrates the behavior within a longer
    // episode. simulate() then verifies that later ground-truth updates (Order
    // picks the next occupied shelf, Receive the next empty one) account for
    // the discarded item.
    const env = new WarehouseEnv({ horizon: 2000, seed: 42 });
    const counts = simulate(env.events);
    expect(counts.maintenanceOnOccupied).toBeGreaterThan(0);
  });

  it('is deterministic: same seed and horizon give identical events and observations', () => {
    const a = new WarehouseEnv({ horizon: 30, seed: 42 });
    const b = new WarehouseEnv({ horizon: 30, seed: 42 });
    expect(a.events).toEqual(b.events);
    for (let i = 0; i < 30; i++) {
      expect(a.observe()).toBe(b.observe());
      const action = a.expectedActionFor(i);
      a.step(action);
      b.step(action);
    }
    expect(a.judgements).toEqual(b.judgements);
  });

  it('defaults the seed to 42', () => {
    const implicit = new WarehouseEnv({ horizon: 25 });
    const explicit = new WarehouseEnv({ horizon: 25, seed: 42 });
    expect(implicit.events).toEqual(explicit.events);
  });

  it('produces different events for a different seed', () => {
    const a = new WarehouseEnv({ horizon: 50, seed: 42 });
    const b = new WarehouseEnv({ horizon: 50, seed: 43 });
    expect(b.events).not.toEqual(a.events);
  });
});

describe('WarehouseEnv expectedActionFor', () => {
  it('formats ground-truth actions exactly per the action table', () => {
    const env = new WarehouseEnv({ horizon: 200, seed: 42 });
    expect(env.expectedActionFor(0)).toBe('STORE Item_0 shelf_0');
    env.events.forEach((event, i) => {
      const expected =
        event.kind === 'Maintenance'
          ? `MAINTAIN ${event.shelf}`
          : `${event.kind === 'Receive' ? 'STORE' : 'SHIP'} ${event.item} ${event.shelf}`;
      expect(env.expectedActionFor(i)).toBe(expected);
    });
  });

  it('rejects out-of-range and fractional indices', () => {
    const env = new WarehouseEnv({ horizon: 5 });
    expect(() => env.expectedActionFor(-1)).toThrow(RangeError);
    expect(() => env.expectedActionFor(5)).toThrow(RangeError);
    expect(() => env.expectedActionFor(1.5)).toThrow(RangeError);
  });
});

describe('WarehouseEnv observations', () => {
  it('renders the event line, the telemetry header, and 1-4 clean noise lines', () => {
    const env = new WarehouseEnv({ horizon: 200, seed: 42 });
    const noiseCounts = new Set<number>();
    env.events.forEach((event, i) => {
      const observation = env.observe();
      expect(observation).toContain(TELEMETRY_HEADER);
      const { firstLine, noiseLines } = splitObservation(observation);
      if (event.kind === 'Receive') {
        expect(firstLine).toBe(`Shipment arrived containing [${event.item}]`);
      } else if (event.kind === 'Order') {
        expect(firstLine).toBe(`Customer ordered [${event.item}]`);
      } else {
        expect(firstLine).toBe(`Maintenance required on [${event.shelf}]`);
      }
      expect(noiseLines.length).toBeGreaterThanOrEqual(1);
      expect(noiseLines.length).toBeLessThanOrEqual(4);
      noiseCounts.add(noiseLines.length);
      for (const line of noiseLines) {
        expect(line.length).toBeGreaterThan(0);
        expect(line).not.toMatch(/shelf/i);
        expect(line).not.toMatch(/item/i);
      }
      env.step(env.expectedActionFor(i));
    });
    expect(noiseCounts.size).toBeGreaterThan(1);
  });

  it('shows the first event line before any step', () => {
    const env = new WarehouseEnv({ horizon: 1 });
    expect(env.observe().split('\n')[0]).toBe('Shipment arrived containing [Item_0]');
  });
});

describe('WarehouseEnv stepping, done, and judgements', () => {
  it('advances the cursor with step() and flips done at the horizon', () => {
    const env = new WarehouseEnv({ horizon: 3, seed: 42 });
    expect(env.done).toBe(false);
    env.step(env.expectedActionFor(0));
    expect(env.done).toBe(false);
    expect(env.judgements).toHaveLength(1);
    env.step(env.expectedActionFor(1));
    env.step(env.expectedActionFor(2));
    expect(env.done).toBe(true);
    expect(env.judgements).toHaveLength(3);
    expect(env.judgements.map((judgement) => judgement.step)).toEqual([0, 1, 2]);
  });

  it('throws when observing or stepping after the episode is done', () => {
    const env = new WarehouseEnv({ horizon: 1 });
    env.step('STORE Item_0 shelf_0');
    expect(env.done).toBe(true);
    expect(() => env.observe()).toThrow(/finished/);
    expect(() => env.step('STORE Item_1 shelf_1')).toThrow(/finished/);
  });

  it('normalizes case and whitespace when judging', () => {
    const env = new WarehouseEnv({ horizon: 3, seed: 42 });
    env.step('  store   item_0    shelf_0  ');
    const judgement = env.judgements[0];
    expect(judgement?.correct).toBe(true);
    expect(judgement?.step).toBe(0);
    expect(judgement?.expectedAction).toBe('STORE Item_0 shelf_0');
    expect(judgement?.actualAction).toBe('  store   item_0    shelf_0  ');
    expect(judgement?.event).toEqual(env.events[0]);
  });

  it('records an incorrect action without stopping the episode', () => {
    const env = new WarehouseEnv({ horizon: 2, seed: 42 });
    env.step('STORE Item_0 shelf_7');
    expect(env.judgements[0]?.correct).toBe(false);
    expect(env.done).toBe(false);
    expect(env.observe()).toContain(TELEMETRY_HEADER);
  });

  it('satisfies the Environment interface', () => {
    const env: Environment = new WarehouseEnv({ horizon: 2, seed: 42 });
    expect(typeof env.observe()).toBe('string');
    env.step('STORE Item_0 shelf_0');
    expect(env.done).toBe(false);
    env.step('anything');
    expect(env.done).toBe(true);
  });
});

describe('WarehouseEnv score', () => {
  it('reports zeros before any step', () => {
    const env = new WarehouseEnv({ horizon: 5 });
    expect(env.score()).toEqual({ judged: 0, correct: 0, accuracy: 0 });
  });

  it('scores an oracle run at accuracy 1', () => {
    const env = new WarehouseEnv({ horizon: 50, seed: 7 });
    for (let i = 0; i < 50; i++) {
      env.step(env.expectedActionFor(i));
    }
    expect(env.score()).toEqual({ judged: 50, correct: 50, accuracy: 1 });
  });

  it('drops exactly one correct step per wrong action', () => {
    const env = new WarehouseEnv({ horizon: 50, seed: 7 });
    for (let i = 0; i < 50; i++) {
      env.step(i === 10 ? 'DO SOMETHING WRONG' : env.expectedActionFor(i));
    }
    const score = env.score();
    expect(score.judged).toBe(50);
    expect(score.correct).toBe(49);
    expect(score.accuracy).toBeCloseTo(49 / 50, 10);
  });
});
