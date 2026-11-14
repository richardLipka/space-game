import type { ShipDesign } from "../data/schemas/design";
import type { AsteroidSpawn, GravityWell, Scenario } from "../data/schemas/scenario";
import { validateDesign, validateScenario } from "../data/validate";

/**
 * Scenario editor model (no DOM): ships, asteroids, black holes and player spawns placed on the map, kept as
 * a `Scenario` that the game plays as it is. Items are addressed by kind and index.
 */

/** AI profile meaning "no pilot": the ship stays where it is placed; automatic weapon groups still fire. */
export const NO_AI = "none";

export type ItemKind = "ship" | "asteroid" | "well" | "spawn";
export interface ItemRef {
  readonly kind: ItemKind;
  readonly index: number;
}

export const BLACK_HOLE: Omit<GravityWell, "position"> = {
  mu: 4e7,
  softening: 20,
  coreRadius: 60,
  cutoffRadius: 3000,
};

export function emptyScenario(id: string, now = new Date()): Scenario {
  return {
    id,
    name: "New scenario",
    description: "",
    budget: 1000,
    maxPlayerShips: 1,
    arena: { width: 8000, height: 6000, asteroids: [], gravityWells: [] },
    playerSpawns: [{ position: [-2500, 0], angle: 0 }],
    enemies: [],
    objective: { type: "destroyAll" },
    seed: now.getTime() % 100000,
  };
}

const round = (v: number, step = 1) => Math.round(v / step) * step;
const clone = (s: Scenario): Scenario => structuredClone(s);

/** Convex, counter-clockwise asteroid outline of about `radius` metres (deterministic for a seed). */
export function asteroidOutline(radius: number, seed: number): [number, number][] {
  let a = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => {
    a ^= a << 13;
    a ^= a >>> 17;
    a ^= a << 5;
    return (a >>> 0) / 4294967296;
  };
  const n = 6 + Math.floor(rnd() * 3);
  // Radii vary a little; equal angular steps keep the polygon convex for this spread.
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    const r = radius * (0.85 + rnd() * 0.2);
    return [Number((Math.cos(t) * r).toFixed(1)), Number((Math.sin(t) * r).toFixed(1))];
  });
}

export const asteroidRadius = (a: AsteroidSpawn): number =>
  Math.max(...a.outline.map(([x, y]) => Math.hypot(x, y)));

export class ScenarioModel {
  private past: Scenario[] = [];
  private future: Scenario[] = [];
  constructor(public scenario: Scenario) {}

  private change(f: (s: Scenario) => void): void {
    this.past.push(clone(this.scenario));
    if (this.past.length > 100) this.past.shift();
    this.future = [];
    const next = clone(this.scenario);
    f(next);
    this.scenario = next;
  }

  undo(): boolean {
    const p = this.past.pop();
    if (!p) return false;
    this.future.push(this.scenario);
    this.scenario = p;
    return true;
  }
  redo(): boolean {
    const f = this.future.pop();
    if (!f) return false;
    this.past.push(this.scenario);
    this.scenario = f;
    return true;
  }

  /** Replaces the whole scenario (load, new); clears history. */
  load(s: Scenario): void {
    this.scenario = clone(s);
    this.past = [];
    this.future = [];
  }

  edit(f: (s: Scenario) => void): void {
    this.change(f);
  }

  addShip(designId: string, x: number, y: number, team: number, aiProfile: string, angle?: number): ItemRef {
    this.change((s) =>
      s.enemies.push({
        designId,
        aiProfile,
        team,
        // Ships face the other side by default: team 0 looks right, others left.
        spawn: { position: [round(x), round(y)], angle: angle ?? (team === 0 ? 0 : 180) },
      }),
    );
    return { kind: "ship", index: this.scenario.enemies.length - 1 };
  }

  addAsteroid(x: number, y: number, radius: number): ItemRef {
    const seed = this.scenario.arena.asteroids.length + 1 + round(x) * 7 + round(y) * 13;
    this.change((s) =>
      s.arena.asteroids.push({
        position: [round(x), round(y)],
        angle: 0,
        outline: asteroidOutline(radius, seed),
        static: true,
      }),
    );
    return { kind: "asteroid", index: this.scenario.arena.asteroids.length - 1 };
  }

  addWell(x: number, y: number, well: Omit<GravityWell, "position"> = BLACK_HOLE): ItemRef {
    this.change((s) => s.arena.gravityWells.push({ position: [round(x), round(y)], ...well }));
    return { kind: "well", index: this.scenario.arena.gravityWells.length - 1 };
  }

  addSpawn(x: number, y: number): ItemRef {
    this.change((s) => s.playerSpawns.push({ position: [round(x), round(y)], angle: 0 }));
    return { kind: "spawn", index: this.scenario.playerSpawns.length - 1 };
  }

  position(r: ItemRef): [number, number] {
    const s = this.scenario;
    if (r.kind === "ship") return s.enemies[r.index]!.spawn.position as [number, number];
    if (r.kind === "asteroid") return s.arena.asteroids[r.index]!.position as [number, number];
    if (r.kind === "well") return s.arena.gravityWells[r.index]!.position as [number, number];
    return s.playerSpawns[r.index]!.position as [number, number];
  }

  /** Moves an item; `record` false while dragging (one undo step is recorded when the drag starts). */
  move(r: ItemRef, x: number, y: number, record = true): void {
    const apply = (s: Scenario) => {
      const p: [number, number] = [round(x), round(y)];
      if (r.kind === "ship") s.enemies[r.index]!.spawn.position = p;
      else if (r.kind === "asteroid") s.arena.asteroids[r.index]!.position = p;
      else if (r.kind === "well") s.arena.gravityWells[r.index]!.position = p;
      else s.playerSpawns[r.index]!.position = p;
    };
    if (record) this.change(apply);
    else apply(this.scenario);
  }

  /** Records an undo step without changing anything (start of a drag). */
  checkpoint(): void {
    this.change(() => {});
  }

  rotate(r: ItemRef, deg: number): void {
    this.change((s) => {
      const t =
        r.kind === "ship" ? s.enemies[r.index]!.spawn : r.kind === "spawn" ? s.playerSpawns[r.index] : null;
      if (t) t.angle = (((t.angle + deg) % 360) + 360) % 360;
      else if (r.kind === "asteroid") {
        const a = s.arena.asteroids[r.index]!;
        a.angle = (((a.angle + deg) % 360) + 360) % 360;
      }
    });
  }

  remove(r: ItemRef): void {
    this.change((s) => {
      if (r.kind === "ship") {
        s.enemies.splice(r.index, 1);
        // Guard indices point into the list: drop guards of the removed ship, shift later ones.
        for (const e of s.enemies) {
          if (e.guard === undefined) continue;
          if (e.guard === r.index) {
            delete e.guard;
            delete e.guardRadius;
          } else if (e.guard > r.index) e.guard--;
        }
      } else if (r.kind === "asteroid") s.arena.asteroids.splice(r.index, 1);
      else if (r.kind === "well") s.arena.gravityWells.splice(r.index, 1);
      else s.playerSpawns.splice(r.index, 1);
    });
  }

  /** Every item at once, for hit tests and drawing. */
  items(): ItemRef[] {
    const s = this.scenario;
    return [
      ...s.arena.gravityWells.map((_, index) => ({ kind: "well" as const, index })),
      ...s.arena.asteroids.map((_, index) => ({ kind: "asteroid" as const, index })),
      ...s.playerSpawns.map((_, index) => ({ kind: "spawn" as const, index })),
      ...s.enemies.map((_, index) => ({ kind: "ship" as const, index })),
    ];
  }

  /** Schema errors plus designs and AI profiles the game would not find. */
  problems(designs: ReadonlyMap<string, ShipDesign>, profiles: ReadonlySet<string>): string[] {
    const out: string[] = [];
    const v = validateScenario(this.scenario);
    if (!v.ok) out.push(...v.errors);
    this.scenario.enemies.forEach((e, i) => {
      if (!designs.has(e.designId)) out.push(`Ship ${i + 1}: unknown design "${e.designId}"`);
      if (e.aiProfile !== NO_AI && !profiles.has(e.aiProfile))
        out.push(`Ship ${i + 1}: unknown AI profile "${e.aiProfile}"`);
    });
    const { width, height } = this.scenario.arena;
    for (const r of this.items()) {
      const [x, y] = this.position(r);
      if (Math.abs(x) > width / 2 || Math.abs(y) > height / 2)
        out.push(`${r.kind} ${r.index + 1} is outside the arena`);
    }
    if (this.scenario.objective.type === "destroyAll" && !this.scenario.enemies.some((e) => e.team !== 0))
      out.push("No enemy ship (team 1 or higher): the battle would be won at once.");
    return out;
  }
}

// ---------- GitHub folders ----------

export interface GithubFolder {
  readonly owner: string;
  readonly repo: string;
  readonly ref: string | null;
  readonly path: string;
}

/**
 * Reads a GitHub folder address: https://github.com/owner/repo/tree/branch/path, owner/repo/path, or
 * owner/repo (repository root). Returns null when it is not one.
 */
export function parseGithubFolder(input: string): GithubFolder | null {
  const t = input.trim().replace(/\/+$/, "");
  const m = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/.exec(t);
  if (m) return { owner: m[1]!, repo: m[2]!, ref: m[3] ?? null, path: m[4] ?? "" };
  const s = /^([\w.-]+)\/([\w.-]+)(?:\/(.*))?$/.exec(t);
  if (s && !t.includes("://")) return { owner: s[1]!, repo: s[2]!, ref: null, path: s[3] ?? "" };
  return null;
}

export interface GithubLoad {
  readonly scenarios: Scenario[];
  readonly designs: ShipDesign[];
  /** Files that were skipped, with the reason. */
  readonly skipped: string[];
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Loads every scenario (and ship design, so scenarios can bring their own ships) in a GitHub folder,
 * through GitHub's public contents API. JSON files that are neither are listed as skipped.
 */
export async function loadGithubFolder(folder: GithubFolder, fetcher: Fetch = fetch): Promise<GithubLoad> {
  const ref = folder.ref ? `?ref=${encodeURIComponent(folder.ref)}` : "";
  const path = folder.path.split("/").map(encodeURIComponent).join("/");
  const res = await fetcher(
    `https://api.github.com/repos/${folder.owner}/${folder.repo}/contents/${path}${ref}`,
  );
  if (!res.ok)
    throw new Error(`GitHub answered ${res.status} for ${folder.owner}/${folder.repo}/${folder.path}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("That address is a file, not a folder.");
  const files = (list as { name: string; type: string; download_url: string | null }[]).filter(
    (f) => f.type === "file" && f.name.endsWith(".json") && f.download_url,
  );
  const out: GithubLoad = { scenarios: [], designs: [], skipped: [] };
  for (const f of files) {
    try {
      const r = await fetcher(f.download_url!);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const s = validateScenario(j);
      if (s.ok) {
        out.scenarios.push(s.value);
        continue;
      }
      const d = validateDesign(j);
      if (d.ok) {
        out.designs.push(d.value);
        continue;
      }
      out.skipped.push(`${f.name}: neither a scenario nor a ship design`);
    } catch (e) {
      out.skipped.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
