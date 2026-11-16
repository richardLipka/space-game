import type { AiProfile } from "../../data/schemas/ai";
import type { ShipDesign } from "../../data/schemas/design";
import type { Scenario } from "../../data/schemas/scenario";
import type { AiState, Order, Roe } from "../ai/brain";
import type { FlightModel } from "../flight/arcade";
import type { PartCatalogue } from "../ship/catalogue";
import type { CrewMember, Ship } from "../ship/ship-entity";
import type { World } from "../world";
import { startBattle, type Battle, type StepHooks } from "./battle";
import type { BattleReport } from "./report";

/**
 * Battle replays (docs/battle-report.md). The simulation is deterministic, so a replay is the battle's set-up
 * plus everything the player changed: rebuilding the world from the set-up and applying the same changes on
 * the same ticks gives the same battle.
 *
 * What the player changes is found without hooking every control: around each world step the recorder
 * takes the "control state" of every ship (intent, weapon command, weapon modes, AI orders and so on). The
 * state after a step and the state before the next step differ only by what the player did in between;
 * those differences are the recording. A hash of the world every few seconds checks the replay stays exact.
 */

export const REPLAY_FORMAT = 1;
/** Ticks between world-hash checkpoints. */
const CHECK_EVERY = 300;

/** Channels of a ship's control state, each kept as JSON. */
type Channels = Record<string, string>;

/** Recorded change: tick, ship index (in `ships`; -1 = the world), changed channels. */
export interface ReplayFrame {
  readonly t: number;
  readonly s: number;
  readonly c: Readonly<Record<string, unknown>>;
}

export interface ReplayData {
  readonly kind: "space-game-replay";
  readonly formatVersion: typeof REPLAY_FORMAT;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly scenario: Scenario;
  readonly fleet: readonly ShipDesign[];
  /** Every design the battle may use (scenario ships) and drone designs. */
  readonly designs: readonly ShipDesign[];
  readonly droneDesigns: readonly ShipDesign[];
  readonly profiles: readonly AiProfile[];
  readonly flightModel: FlightModel;
  /** Officers aboard each ship at the start, by ship id. */
  readonly crews: readonly (readonly [string, readonly CrewMember[]])[];
  /** Ship ids the frames refer to (index = `ReplayFrame.s`). */
  readonly ships: readonly string[];
  /** Control state of every ship when recording started. */
  readonly initial: readonly Readonly<Record<string, unknown>>[];
  readonly frames: readonly ReplayFrame[];
  /** World hash at checkpoints: [tick, hash]. */
  readonly checks: readonly (readonly [number, string])[];
  readonly endTick: number;
  /** Outcome and the after-action report at the end of the recording. */
  readonly status: "running" | "won" | "lost";
  readonly report: BattleReport | null;
}

// ---------- JSON that keeps −0 (the simulation can tell it from 0) ----------
const NEG_ZERO = "\u0000-0";
export const toJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "number" && Object.is(x, -0) ? NEG_ZERO : x));
export const fromJson = <T = unknown>(s: string): T =>
  JSON.parse(s, (_k, x: unknown) => (x === NEG_ZERO ? -0 : x)) as T;

/** Identity of each AI state object, so a fresh one (the AI handed a ship anew) is told from an edited one. */
class AiIds {
  private readonly ids = new WeakMap<AiState, number>();
  private next = 1;
  of(st: AiState): number {
    let id = this.ids.get(st);
    if (id === undefined) {
      id = this.next++;
      this.ids.set(st, id);
    }
    return id;
  }
  set(st: AiState, id: number): void {
    this.ids.set(st, id);
    this.next = Math.max(this.next, id + 1);
  }
}

function aiChannel(st: AiState | undefined, ids: AiIds): unknown {
  if (!st) return null;
  return {
    i: ids.of(st),
    p: st.profile.id,
    o: st.order,
    q: st.queue,
    sl: st.slot,
    pi: st.patrolIndex,
    ne: st.nextEval,
    f: st.focus,
    r: st.roe,
  };
}

function channelsOf(world: World, ship: Ship, ids: AiIds): Channels {
  const w = ship.weaponCommand;
  return {
    ai: toJson(aiChannel(world.ai.get(ship.id), ids)),
    intent: toJson(ship.intent),
    weapons: toJson({ ...w, selected: [...w.selected] }),
    modes: toJson([...ship.groupModes]),
    pd: toJson(ship.pdEngageShips),
    eject: toJson(ship.pendingEject),
    power: toJson(ship.powerPriority),
    missile: toJson(ship.missileType),
    drone: toJson(ship.droneType),
    drive: toJson(ship.driveMode),
    radiators: toJson(ship.radiatorsExtended),
    minHit: toJson(ship.minHitProbability),
    hangars: toJson([...ship.hangarPending]),
  };
}

const worldChannels = (world: World): Channels => ({ flightModel: toJson(world.flightModel) });

interface AiValue {
  readonly i: number;
  readonly p: string;
  readonly o: Order | null;
  readonly q: Order[];
  readonly sl: number;
  readonly pi: number;
  readonly ne: number;
  readonly f: string | null;
  readonly r: Roe;
}

/** Sets recorded channels on a ship (AI first: handing a ship to or from the AI resets weapon modes). */
function applyChannels(
  world: World,
  ship: Ship,
  c: Readonly<Record<string, unknown>>,
  ids: AiIds,
  profiles: ReadonlyMap<string, AiProfile>,
): void {
  if ("ai" in c) {
    const v = c.ai as AiValue | null;
    if (v === null) world.clearAi(ship.id);
    else {
      const profile = profiles.get(v.p);
      if (profile) {
        let st = world.ai.get(ship.id);
        if (!st || ids.of(st) !== v.i) {
          st = world.setAi(ship.id, profile, v.o, v.sl);
          ids.set(st, v.i);
        }
        st.profile = profile;
        st.order = v.o;
        st.queue = [...v.q];
        st.slot = v.sl;
        st.patrolIndex = v.pi;
        st.nextEval = v.ne;
        st.focus = v.f;
        st.roe = v.r;
      }
    }
  }
  for (const [k, raw] of Object.entries(c)) {
    switch (k) {
      case "intent":
        ship.intent = raw as Ship["intent"];
        break;
      case "weapons": {
        const w = raw as Ship["weaponCommand"] & { selected: number[] };
        ship.weaponCommand = { ...w, selected: new Set(w.selected) };
        break;
      }
      case "modes":
        ship.groupModes.clear();
        for (const [g, m] of raw as [number, Ship["groupModes"] extends Map<number, infer M> ? M : never][])
          ship.groupModes.set(g, m);
        break;
      case "pd":
        ship.pdEngageShips = raw as boolean;
        break;
      case "eject":
        ship.pendingEject = [...(raw as string[])];
        break;
      case "power":
        ship.powerPriority = [...(raw as Ship["powerPriority"])];
        break;
      case "missile":
        ship.missileType = raw as string | null;
        break;
      case "drone":
        ship.droneType = raw as string | null;
        break;
      case "drive":
        ship.driveMode = raw as Ship["driveMode"];
        break;
      case "radiators":
        ship.radiatorsExtended = raw as boolean;
        break;
      case "minHit":
        ship.minHitProbability = raw as number;
        break;
      case "hangars":
        ship.hangarPending.clear();
        for (const [uid, n] of raw as [string, number][]) ship.hangarPending.set(uid, n);
        break;
      default:
        break;
    }
  }
}

const parsed = (c: Channels): Record<string, unknown> =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, fromJson(v)]));

export interface RecordSetup {
  readonly title: string;
  readonly fleet: readonly ShipDesign[];
  readonly designs: ReadonlyMap<string, ShipDesign>;
  readonly droneDesigns: readonly ShipDesign[];
  readonly profiles: ReadonlyMap<string, AiProfile>;
  readonly id: string;
  readonly createdAt: string;
}

/** Records a battle from now on (call once the battle is fully set up, before the first step). */
export class BattleRecorder implements StepHooks {
  private readonly ids = new AiIds();
  private readonly ships: Ship[];
  private post: Channels[];
  private postWorld: Channels;
  private readonly initial: Record<string, unknown>[];
  private readonly frames: ReplayFrame[] = [];
  private readonly checks: [number, string][] = [];
  private readonly crews: [string, readonly CrewMember[]][];
  private readonly flightModel: FlightModel;

  constructor(
    private readonly battle: Battle,
    private readonly setup: RecordSetup,
  ) {
    const w = battle.world;
    this.ships = w.allShips().filter((s) => !s.drone);
    this.post = this.ships.map((s) => channelsOf(w, s, this.ids));
    this.postWorld = worldChannels(w);
    this.flightModel = w.flightModel;
    this.initial = this.post.map(parsed);
    this.crews = this.ships.filter((s) => s.crew.length).map((s) => [s.id, s.crew]);
    battle.recorder = this;
  }

  beforeStep(world: World): void {
    this.ships.forEach((s, i) => {
      if (s.escaped) return;
      const now = channelsOf(world, s, this.ids);
      const before = this.post[i]!;
      const c: Record<string, unknown> = {};
      let any = false;
      for (const k in now)
        if (now[k] !== before[k]) {
          c[k] = fromJson(now[k]!);
          any = true;
        }
      if (any) this.frames.push({ t: world.tick, s: i, c });
    });
    const wc = worldChannels(world);
    if (wc.flightModel !== this.postWorld.flightModel)
      this.frames.push({ t: world.tick, s: -1, c: { flightModel: fromJson(wc.flightModel!) } });
  }

  afterStep(world: World): void {
    this.post = this.ships.map((s) => channelsOf(world, s, this.ids));
    this.postWorld = worldChannels(world);
    if (world.tick % CHECK_EVERY === 0) this.checks.push([world.tick, world.hash()]);
  }

  /** The recording so far, with the battle's outcome and report. */
  data(report: BattleReport | null): ReplayData {
    const b = this.battle;
    const used = new Set(b.scenario.enemies.map((e) => e.designId));
    return {
      kind: "space-game-replay",
      formatVersion: REPLAY_FORMAT,
      id: this.setup.id,
      title: this.setup.title,
      createdAt: this.setup.createdAt,
      scenario: b.scenario,
      fleet: [...this.setup.fleet],
      designs: [...this.setup.designs.values()].filter((d) => used.has(d.id)),
      droneDesigns: [...this.setup.droneDesigns],
      profiles: [...this.setup.profiles.values()],
      flightModel: this.flightModel,
      crews: this.crews,
      ships: this.ships.map((s) => s.id),
      initial: this.initial,
      frames: [...this.frames],
      checks: [...this.checks],
      endTick: b.world.tick,
      status: b.status,
      report,
    };
  }
}

/**
 * Plays a recording back: rebuilds the battle from its set-up and applies the recorded changes on their
 * ticks. `diverged` is the first checkpoint tick whose world hash differs (the game changed since, or a
 * control the recorder does not know about), null while the replay matches.
 */
export class ReplayPlayer implements StepHooks {
  private readonly ids = new AiIds();
  private next = 0;
  private check = 0;
  diverged: number | null = null;
  readonly battle: Battle;
  private readonly profiles: Map<string, AiProfile>;

  constructor(
    readonly data: ReplayData,
    catalogue: PartCatalogue,
    extraProfiles: ReadonlyMap<string, AiProfile> = new Map(),
  ) {
    this.profiles = new Map(extraProfiles);
    for (const p of data.profiles) this.profiles.set(p.id, p);
    const designs = new Map<string, ShipDesign>();
    for (const d of [...data.designs, ...data.droneDesigns]) designs.set(d.id, d);
    const b = startBattle(data.scenario, data.fleet, catalogue, {
      designs,
      profiles: this.profiles,
      droneDesigns: data.droneDesigns,
    });
    const w = b.world;
    w.flightModel = data.flightModel;
    for (const [id, crew] of data.crews) if (w.hasShip(id)) w.getShip(id).setCrew(crew);
    // The control state at the start of the recording (AI orders, weapon modes …).
    data.ships.forEach((id, i) => {
      const c = data.initial[i];
      if (c && w.hasShip(id)) applyChannels(w, w.getShip(id), c, this.ids, this.profiles);
    });
    b.recorder = this;
    this.battle = b;
  }

  /** The recording has been played to its end. */
  get done(): boolean {
    return this.battle.world.tick >= this.data.endTick;
  }

  beforeStep(world: World): void {
    const f = this.data.frames;
    while (this.next < f.length && f[this.next]!.t <= world.tick) {
      const fr = f[this.next++]!;
      if (fr.t < world.tick) continue;
      if (fr.s < 0) {
        if ("flightModel" in fr.c) world.flightModel = fr.c.flightModel as FlightModel;
        continue;
      }
      const id = this.data.ships[fr.s];
      if (id && world.hasShip(id)) applyChannels(world, world.getShip(id), fr.c, this.ids, this.profiles);
    }
  }

  afterStep(world: World): void {
    const c = this.data.checks;
    while (this.check < c.length && c[this.check]![0] < world.tick) this.check++;
    const at = c[this.check];
    if (at && at[0] === world.tick) {
      this.check++;
      if (this.diverged === null && world.hash() !== at[1]) this.diverged = world.tick;
    }
  }
}

/** A recording read from a file: the fields a replay needs, or why it cannot be used. */
export function readReplay(raw: unknown): { ok: true; value: ReplayData } | { ok: false; error: string } {
  const r = raw as Partial<ReplayData> | null;
  if (!r || typeof r !== "object" || r.kind !== "space-game-replay")
    return { ok: false, error: "Not a replay file." };
  if (r.formatVersion !== REPLAY_FORMAT)
    return { ok: false, error: "Replay from another version of the game." };
  for (const k of [
    "scenario",
    "fleet",
    "designs",
    "profiles",
    "ships",
    "initial",
    "frames",
    "checks",
  ] as const)
    if (r[k] === undefined) return { ok: false, error: `Replay file is missing "${k}".` };
  return { ok: true, value: r as ReplayData };
}
