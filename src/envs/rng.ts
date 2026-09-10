/**
 * Small deterministic PRNG utilities for the benchmark environments.
 * Replaces the Python `random` calls of the paper's reference code so event
 * streams are reproducible across machines and runs.
 */

/** mulberry32: deterministic 32-bit seeded PRNG. Returns () => float in [0,1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic integer in [0, n). Throws when n is not a positive integer. */
export function randInt(rng: () => number, n: number): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`randInt(): n must be a positive integer, got ${n}`);
  }
  return Math.floor(rng() * n);
}

/** Deterministic pick, mirroring Python random.choice semantics. Throws on an empty array. */
export function choice<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error('choice(): cannot pick from an empty array');
  }
  const item = items[randInt(rng, items.length)];
  if (item === undefined) {
    throw new Error('choice(): internal error, index out of range');
  }
  return item;
}
