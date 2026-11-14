import type { Scenario } from "../data/schemas/scenario";

/** Spawn points and headings moved by a seeded random amount (the same job always moves them the same). */
export function jitterSpawns(
  sc: Scenario,
  seed: number,
  j: { readonly position: number; readonly angle: number },
): Scenario {
  let state = (seed * 2654435761) | 0;
  const rnd = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
  const move = (t: { position: [number, number]; angle: number }) => ({
    position: [t.position[0] + rnd() * j.position, t.position[1] + rnd() * j.position] as [number, number],
    angle: t.angle + rnd() * j.angle,
  });
  return {
    ...sc,
    enemies: sc.enemies.map((e) => ({ ...e, spawn: move(e.spawn) })),
    playerSpawns: sc.playerSpawns.map(move),
  };
}
