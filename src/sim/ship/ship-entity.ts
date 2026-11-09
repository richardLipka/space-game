import type { PowerGroup, ShipDesign, WeaponGroupSettings } from "../../data/schemas/design";
import { allocate, wrenchOf, type Wrench } from "../flight/allocator";
import { flightControl, IDLE_INTENT, type ControlIntent, type FlightState } from "../flight/controller";
import {
  buildPropulsion,
  capabilities,
  type PropulsionContext,
  type PropulsionModel,
} from "../flight/propulsion";
import { type Vec2, ZERO } from "../core/vec2";
import { compareIds } from "../core/ids";
import { computeNetworks, type Networks } from "../systems/networks";
import { allocatePower, POWER_GROUPS, type PowerConsumer } from "../systems/power";
import {
  HEAT,
  heatThrottle,
  hullDissipation,
  NO_HEAT_FLOW,
  overheatDamage,
  radiatorDissipation,
  stepHeat,
  type HeatFlow,
  type HeatSources,
} from "../systems/heat";
import { refillWeapons, type MagazineStore, type WeaponFeed } from "../systems/ammo";
import { LayoutIndex, radiatorEdgeBlockers, turretBlockedRanges, type Connection } from "./layout";
import {
  createWeaponState,
  IDLE_WEAPONS,
  type GroupMode,
  type WeaponCommand,
  type WeaponState,
} from "../combat/weapons";
import { afterArmor } from "../combat/damage";
import { EXPLOSION, storeBlast } from "../combat/constants";
import { partCentroid } from "./ship";
import {
  computeMassProps,
  hpFactor,
  isIntact,
  partMass,
  partPiecesShipFrame,
  type MassProps,
  type PartInstance,
} from "./ship";

/** A drone's tie to the ship that launched it (spec §9.7). */
export interface DroneLink {
  readonly mother: string;
  readonly hangarUid: string;
  readonly role: "attack" | "pd" | "decoy";
  readonly launchTick: number;
}

/** Drone behaviour from its parts: a decoy emitter makes a decoy, a PD turret a PD escort, else attack. */
export function droneRole(parts: readonly PartInstance[]): DroneLink["role"] {
  if (parts.some((p) => p.def.def.decoy)) return "decoy";
  if (parts.some((p) => p.def.def.weapon?.kind === "pd")) return "pd";
  return "attack";
}

/** Relative mass change that triggers a mass-property recompute (spec §6.1). */
export const MASS_RECOMPUTE_THRESHOLD = 0.005;

export interface PowerReport {
  /** Supply capacity of the command network (W). */
  readonly supply: number;
  readonly used: number;
  readonly groups: Readonly<Record<PowerGroup, { readonly demand: number; readonly factor: number }>>;
  readonly batteryCharge: number;
  readonly batteryCapacity: number;
}

const emptyReport = (): PowerReport => ({
  supply: 0,
  used: 0,
  groups: Object.fromEntries(POWER_GROUPS.map((g) => [g, { demand: 0, factor: 1 }])) as PowerReport["groups"],
  batteryCharge: 0,
  batteryCapacity: 0,
});

/** Power group of a part's consumer role, or null if it draws no power. */
function consumerGroup(p: PartInstance): PowerGroup | null {
  const d = p.def.def;
  if ((d.command?.powerDraw ?? 0) > 0 || (d.gyro?.powerDraw ?? 0) > 0) return "gyro";
  if ((d.engine?.powerDraw ?? 0) > 0 || (d.thruster?.powerDraw ?? 0) > 0) return "propulsion";
  const w = d.weapon;
  if (w && ((w.powerDraw ?? 0) > 0 || (w.powerPerShot ?? 0) > 0))
    return w.kind === "pd" ? "pointDefense" : "weapons";
  return null;
}

/**
 * Runtime ship: parts, resource networks, power, heat, fuel, ammo, flight state and last control outputs.
 * The physics body id equals the ship id.
 */
export class Ship {
  intent: ControlIntent = IDLE_INTENT;
  readonly flight: FlightState = { speedKill: "off" };
  massProps: MassProps;
  private propsMass: number;
  massRecomputes = 0;
  propulsion: PropulsionModel = { actuators: [], engines: [] };
  throttles: number[] = [];
  lastWrench: Wrench = { fx: 0, fy: 0, torque: 0 };
  lastDesired: Wrench = { fx: 0, fy: 0, torque: 0 };
  /** Speed-kill reference velocity provider (spec §6.7 hook): world zero for now. */
  referenceVelocity: () => Vec2 = () => ZERO;

  /** Structural connections (destroyed parts stay in place as wrecks; only ejection changes them). */
  connections: readonly Connection[] = [];
  /** Radiator exposure (uncovered share of radiating edges), recomputed when the structure changes. */
  radiatorExposure: ReadonlyMap<string, number> = new Map();
  /** Uncovered hull outline (m) that radiates heat (spec §7.4). */
  hullExposedLength = 0;
  networks: Networks = { networkOf: new Map(), members: [] };
  private networksDirty = true;
  /** Network index containing the command module, or null if it is destroyed. */
  commandNetwork: number | null = null;
  networkRecomputes = 0;

  /** Player-set power priority (spec §7.2); starts from the design and can change live. */
  powerPriority: PowerGroup[];
  power: PowerReport = emptyReport();
  private powerFactors = new Map<string, number>();
  private reactorOutput = new Map<string, number>();
  /** Last throttle per part uid (drives next tick's propulsion power demand and heat). */
  private lastThrottle = new Map<string, number>();
  /** Weapons currently drawing power (set by combat from M4; tests may set it directly). */
  readonly activeWeapons = new Set<string>();

  /** Heat pool (J) and radiator state (spec §7.4). */
  heat = 0;
  radiatorsExtended = true;
  /** Heat generated and dissipated last tick (W), with a breakdown for the HUD. */
  heatFlow: HeatFlow = NO_HEAT_FLOW;

  private readonly byUid: Map<string, PartInstance>;
  /** Design-frame geometry (wrecks keep their shape; ejection rebuilds it). */
  layout!: LayoutIndex;
  /** Parts the pilot asked to eject; the world removes them at the start of the next tick. */
  pendingEject: string[] = [];

  // ---------- combat (spec §8, §9) ----------
  weapons: WeaponState[] = [];
  weaponCommand: WeaponCommand = { ...IDLE_WEAPONS, selected: new Set(IDLE_WEAPONS.selected) };
  readonly groupModes = new Map<number, GroupMode>();
  /** Per-group fire range and target priority from the design (decision log: Weapon groups). */
  readonly groupSettings = new Map<number, WeaponGroupSettings>();
  /** Set once defeat conditions are met (spec §8.1); never cleared. */
  defeated = false;
  defeatReason: "command-destroyed" | "incapacitated" | null = null;
  /** PD turrets also fire at ships when no missiles or drones are in reach (spec §9.6). */
  pdEngageShips = false;
  /** AI-mode weapons fire at ships only above this estimated hit probability (AI fire control, §11.2). */
  minHitProbability = 0;
  /** Set for drones (spec §9.7). */
  drone: DroneLink | null = null;
  /** Drone that lost fuel, link or decoy lifetime: no control, no weapons (spec §9.7). Never cleared. */
  inert = false;
  inertReason: "no-fuel" | "out-of-range" | "mother-lost" | "expired" | null = null;
  /** Drones each hangar still has to launch, and seconds until it can launch the next one. */
  readonly hangarPending = new Map<string, number>();
  readonly hangarCooldown = new Map<string, number>();
  /** Drones of this ship still under control (set by the world each tick); they keep it in the fight. */
  liveDrones = 0;
  /** Instant heat (J) added since the last heat update, e.g. per-shot heat. */
  private pendingHeat = 0;
  /** Destroyed parts that explode, processed by the world after damage (spec §8). */
  pendingExplosions: { uid: string; center: Vec2; radius: number; damage: number }[] = [];

  constructor(
    readonly id: string,
    readonly design: ShipDesign,
    readonly parts: PartInstance[],
    readonly team: number,
  ) {
    this.massProps = computeMassProps(parts);
    this.propsMass = this.massProps.mass;
    this.byUid = new Map(parts.map((p) => [p.uid, p]));
    this.powerPriority = [...(design.powerPriority as PowerGroup[])];
    const groupOf = new Map(design.parts.map((p) => [p.uid, p.weaponGroup]));
    this.rebuildStructure((p, blocked) => createWeaponState(p, groupOf.get(p.uid), blocked));
    for (const [g, mode] of Object.entries(design.weaponGroupModes)) this.groupModes.set(Number(g), mode);
    for (const [g, set] of Object.entries(design.weaponGroups ?? {})) this.groupSettings.set(Number(g), set);
    this.updateNetworks();
  }

  /**
   * Recomputes everything derived from the part layout: connections, radiator and hull exposure and
   * turret blocking. Runs at construction and after ejection; weapon states are kept for remaining weapons.
   */
  private rebuildStructure(
    create: (p: PartInstance, blocked: [number, number][]) => WeaponState = (p, blocked) =>
      createWeaponState(p, undefined, blocked),
  ): void {
    const layout = new LayoutIndex(this.parts);
    this.layout = layout;
    this.connections = layout.connections();
    const old = new Map(this.weapons.map((w) => [w.uid, w]));
    this.weapons = this.parts
      .filter((p) => p.def.def.weapon)
      .sort((a, b) => compareIds(a.uid, b.uid))
      .map((p) => {
        const blocked = turretBlockedRanges(layout, p);
        const w = old.get(p.uid);
        if (!w) return create(p, blocked);
        w.blocked = blocked;
        return w;
      });
    const exposure = new Map<string, number>();
    for (const p of this.parts) {
      if (!p.def.def.radiator) continue;
      let len = 0;
      let exposed = 0;
      for (const e of layout.edges.get(p.uid)!) {
        if (e.type !== "function") continue;
        len += e.length;
        // A face with anything in its keep-clear zone radiates nothing.
        if (radiatorEdgeBlockers(layout, p, e.index).length > 0) continue;
        exposed += e.length * layout.exposedFraction(p.uid, e.index);
      }
      exposure.set(p.uid, len > 0 ? exposed / len : 0);
    }
    this.radiatorExposure = exposure;
    this.hullExposedLength = layout.exposedHullLength();
  }

  part(uid: string): PartInstance {
    const p = this.byUid.get(uid);
    if (!p) throw new Error(`Unknown part ${uid} on ${this.id}`);
    return p;
  }

  // ---------- networks ----------
  markNetworksDirty(): void {
    this.networksDirty = true;
  }

  updateNetworks(): void {
    if (!this.networksDirty) return;
    this.networks = computeNetworks(
      this.parts.map((p) => ({ uid: p.uid, intact: isIntact(p), conducts: p.def.def.conducts !== false })),
      this.connections,
    );
    const cmd = this.parts.find((p) => p.def.def.command && isIntact(p));
    this.commandNetwork = cmd ? (this.networks.networkOf.get(cmd.uid) ?? null) : null;
    this.networksDirty = false;
    this.networkRecomputes++;
  }

  networkOf(uid: string): number | undefined {
    return this.networks.networkOf.get(uid);
  }

  /** True when the part can take commands (its network contains the command module, spec §7.1). */
  isCommanded(uid: string): boolean {
    const n = this.networkOf(uid);
    return n !== undefined && n === this.commandNetwork;
  }

  private membersOf(net: number): PartInstance[] {
    return (this.networks.members[net] ?? []).map((u) => this.byUid.get(u)!);
  }

  // ---------- fuel ----------
  get totalFuel(): number {
    let f = 0;
    for (const p of this.parts) f += p.fuel;
    return f;
  }

  get fuelCapacity(): number {
    let c = 0;
    for (const p of this.parts) c += p.def.def.fuelTank?.capacity ?? 0;
    return c;
  }

  fuelInNetwork(net: number | undefined): number {
    if (net === undefined) return 0;
    let f = 0;
    for (const p of this.membersOf(net)) f += p.fuel;
    return f;
  }

  /** Draws fuel proportionally from the tanks of one network (spec §7.3). Returns kg drawn. */
  consumeFuelFromNetwork(net: number, kg: number): number {
    const tanks = this.membersOf(net).filter((p) => p.fuel > 0);
    const total = tanks.reduce((s, p) => s + p.fuel, 0);
    if (kg <= 0 || total <= 0) return 0;
    const take = Math.min(kg, total);
    const k = take / total;
    for (const p of tanks) p.fuel -= p.fuel * k;
    return take;
  }

  // ---------- heat ----------
  get heatCapacity(): number {
    let c = HEAT.baseCapacity;
    for (const p of this.parts) if (isIntact(p)) c += p.def.def.heatSink?.capacity ?? 0;
    return c;
  }

  get heatLevel(): number {
    return this.heat / this.heatCapacity;
  }

  /** Output multiplier for a part from power served and heat throttling. */
  partFactor(uid: string): number {
    const p = this.part(uid);
    const d = p.def.def;
    let f = 1;
    if (consumerGroup(p)) f *= this.powerFactors.get(uid) ?? 0;
    const producesHeat =
      (d.engine?.heatAtMax ?? 0) > 0 ||
      (d.thruster?.heatAtMax ?? 0) > 0 ||
      (d.gyro?.heat ?? 0) > 0 ||
      !!d.reactor;
    if (producesHeat) f *= heatThrottle(this.heatLevel);
    return f;
  }

  // ---------- per-tick systems ----------
  /** Steps 2–3 of the tick (plan §13.3): networks, then power allocation per network. */
  preStep(dt: number): void {
    this.updateNetworks();
    this.powerFactors = new Map();
    this.reactorOutput = new Map();
    const throttle = heatThrottle(this.heatLevel);
    let report = emptyReport();
    this.networks.members.forEach((members, net) => {
      const parts = members.map((u) => this.byUid.get(u)!);
      const commanded = net === this.commandNetwork;
      const sources = parts
        .filter((p) => p.def.def.reactor)
        .map((p) => ({ uid: p.uid, maxOutput: p.def.def.reactor!.maxOutput * hpFactor(p) * throttle }));
      const batteries = parts
        .filter((p) => p.def.def.battery)
        .map((p) => {
          const b = p.def.def.battery!;
          const hf = hpFactor(p);
          return {
            uid: p.uid,
            charge: p.charge,
            capacity: b.capacity * hf,
            maxCharge: b.maxCharge * hf,
            maxDischarge: b.maxDischarge * hf,
          };
        });
      const consumers: PowerConsumer[] = [];
      for (const p of parts) {
        const group = consumerGroup(p);
        if (!group) continue;
        const d = p.def.def;
        let demand = 0;
        // Uncommanded networks only run automatic systems (point defense, from M5).
        if (!commanded && group !== "pointDefense") demand = 0;
        else if (group === "gyro") demand = (d.command?.powerDraw ?? 0) + (d.gyro?.powerDraw ?? 0);
        else if (group === "propulsion")
          demand =
            ((d.engine?.powerDraw ?? 0) + (d.thruster?.powerDraw ?? 0)) * (this.lastThrottle.get(p.uid) ?? 0);
        else if (this.activeWeapons.has(p.uid))
          demand = (d.weapon!.powerDraw ?? 0) + (d.weapon!.powerPerShot ?? 0) / d.weapon!.fireInterval;
        consumers.push({ uid: p.uid, group, demand });
      }
      const res = allocatePower(sources, batteries, consumers, this.powerPriority, dt);
      for (const [uid, f] of res.factors)
        this.powerFactors.set(uid, commanded || this.byUid.get(uid)!.def.def.weapon?.kind === "pd" ? f : 0);
      for (const [uid, w] of res.reactorOutput) this.reactorOutput.set(uid, w);
      for (const [uid, c] of res.batteryCharge) this.byUid.get(uid)!.charge = c;
      if (commanded) {
        report = {
          supply: res.supply,
          used: res.used,
          groups: Object.fromEntries(
            POWER_GROUPS.map((g) => [g, { demand: res.groupDemand[g], factor: res.groupFactor[g] }]),
          ) as PowerReport["groups"],
          batteryCharge: batteries.reduce((s, b) => s + res.batteryCharge.get(b.uid)!, 0),
          batteryCapacity: batteries.reduce((s, b) => s + b.capacity, 0),
        };
      }
    });
    this.power = report;
  }

  /** Steps 4–5: intent → desired wrench → throttles → achieved wrench, consuming fuel per network. */
  control(ctx: {
    angle: number;
    angularVelocity: number;
    velocity: Vec2;
    dt: number;
    disabled?: boolean;
  }): Wrench {
    const mp = this.massProps;
    if (ctx.disabled) {
      this.propulsion = { actuators: [], engines: [] };
      this.throttles = [];
      this.lastThrottle = new Map();
      this.lastWrench = { fx: 0, fy: 0, torque: 0 };
      return this.lastWrench;
    }
    this.propulsion = this.propulsionNow();
    const acts = this.propulsion.actuators;
    const { desired, weights } = flightControl(this.intent, this.flight, {
      mass: mp.mass,
      inertia: mp.inertia,
      angle: ctx.angle,
      angularVelocity: ctx.angularVelocity,
      velocity: ctx.velocity,
      referenceVelocity: this.referenceVelocity(),
      caps: capabilities(acts),
      dt: ctx.dt,
    });
    let u = allocate(acts, desired, { weights });

    // Fuel per network: scale down a network's actuators if its tanks run dry this tick.
    const flowByNet = new Map<number, number>();
    acts.forEach((a, i) => {
      if (a.fuelFlow <= 0 || u[i]! <= 0) return;
      const net = this.networkOf(a.partUid)!;
      flowByNet.set(net, (flowByNet.get(net) ?? 0) + a.fuelFlow * u[i]! * ctx.dt);
    });
    const scaleByNet = new Map<number, number>();
    for (const [net, kg] of [...flowByNet].sort((x, y) => x[0] - y[0])) {
      const drawn = this.consumeFuelFromNetwork(net, kg);
      scaleByNet.set(net, kg > 0 ? drawn / kg : 1);
    }
    u = u.map((t, i) =>
      acts[i]!.fuelFlow > 0 ? t * (scaleByNet.get(this.networkOf(acts[i]!.partUid)!) ?? 1) : t,
    );

    this.throttles = u;
    this.lastThrottle = new Map();
    acts.forEach((a, i) =>
      this.lastThrottle.set(a.partUid, Math.max(this.lastThrottle.get(a.partUid) ?? 0, u[i]!)),
    );
    this.lastDesired = desired;
    this.lastWrench = wrenchOf(acts, u);
    if (this.intent.speedKill) this.intent = { ...this.intent, speedKill: undefined };
    return this.lastWrench;
  }

  /**
   * Propulsion as it is right now: intact, commanded, fuelled and powered actuators only. The AI's
   * capability profile reads it (spec §11.1); control() uses it every tick.
   */
  propulsionNow(): PropulsionModel {
    this.updateNetworks();
    const pctx: PropulsionContext = {
      hasFuel: (uid) => this.fuelInNetwork(this.networkOf(uid)) > 0,
      factor: (uid) => this.partFactor(uid),
      commanded: (uid) => this.isCommanded(uid),
    };
    return buildPropulsion(this.parts, this.massProps, pctx);
  }

  /** Steps 11–12: heat, overheat damage, ammo refill, part state. */
  postStep(dt: number): void {
    const throttle = heatThrottle(this.heatLevel);
    let generation = 0;
    const sources: HeatSources = { reactors: 0, propulsion: 0, gyros: 0, weapons: 0 };
    const producers: PartInstance[] = [];
    for (const p of this.parts) {
      if (!isIntact(p)) continue;
      const d = p.def.def;
      const t = this.lastThrottle.get(p.uid) ?? 0;
      const reactor = d.reactor ? (this.reactorOutput.get(p.uid) ?? 0) * d.reactor.heatPerWatt : 0;
      const propulsion = ((d.engine?.heatAtMax ?? 0) + (d.thruster?.heatAtMax ?? 0)) * t * throttle;
      const gyro = d.gyro && d.gyro.heat > 0 ? d.gyro.heat * t * throttle : 0;
      let weapon = 0;
      if (d.weapon && this.activeWeapons.has(p.uid)) {
        // A browned-out powered weapon only works (and heats) in proportion to the power it receives.
        const served = consumerGroup(p) ? (this.powerFactors.get(p.uid) ?? 0) : 1;
        weapon =
          ((d.weapon.heatWhileFiring ?? 0) + (d.weapon.heatPerShot ?? 0) / d.weapon.fireInterval) * served;
      }
      sources.reactors += reactor;
      sources.propulsion += propulsion;
      sources.gyros += gyro;
      sources.weapons += weapon;
      const g = reactor + propulsion + gyro + weapon;
      if (g > 0) producers.push(p);
      generation += g;
    }
    let dissipation = 0;
    for (const p of this.parts) {
      const r = p.def.def.radiator;
      if (!r || !isIntact(p)) continue;
      dissipation += radiatorDissipation(
        {
          dissipation: r.dissipation,
          exposedFraction: this.radiatorExposure.get(p.uid) ?? 0,
          retractedFactor: r.retractedFactor,
          hpFactor: hpFactor(p),
        },
        this.radiatorsExtended,
      );
    }
    const hull = hullDissipation(this.hullExposedLength);
    // Per-shot heat arrives as joules; report it as average power over this tick.
    const shotHeat = this.pendingHeat / dt;
    sources.weapons += shotHeat;
    this.heat = stepHeat(this.heat + this.pendingHeat, generation, dissipation + hull, dt);
    this.heatFlow = {
      generation: generation + shotHeat,
      dissipation: dissipation + hull,
      radiators: dissipation,
      hull,
      sources,
    };
    this.pendingHeat = 0;

    const level = this.heatLevel;
    if (level > 1) {
      for (const p of producers.sort((a, b) => compareIds(a.uid, b.uid))) {
        p.hp -= overheatDamage(level, p.def.def.hp, dt);
        if (p.hp <= 0) this.destroyPart(p.uid);
      }
    }

    // Ammo: refill weapons from magazines on the same network.
    this.networks.members.forEach((members) => {
      const ps = members.map((u) => this.byUid.get(u)!);
      const mags: (MagazineStore & { part: PartInstance })[] = ps
        .filter((p) => p.def.def.magazine && p.ammo > 0)
        .map((p) => ({ uid: p.uid, ammoType: p.def.def.magazine!.ammoType, rounds: p.ammo, part: p }));
      const feeds: (WeaponFeed & { part: PartInstance })[] = ps
        .filter((p) => p.def.def.weapon?.ammoType && p.def.def.weapon.internalMagazine > 0)
        .map((p) => ({
          uid: p.uid,
          ammoType: p.def.def.weapon!.ammoType!,
          internalCapacity: p.def.def.weapon!.internalMagazine,
          internal: p.ammo,
          part: p,
        }));
      if (mags.length === 0 || feeds.length === 0) return;
      refillWeapons(feeds, mags, dt);
      for (const m of mags) m.part.ammo = m.rounds;
      for (const f of feeds) f.part.ammo = f.internal;
    });
  }

  // ---------- ejection ----------
  /** Any part except a command module can be jettisoned, intact or wrecked (decision log: Ejection). */
  canEject(uid: string): boolean {
    const p = this.byUid.get(uid);
    return !!p && !p.def.def.command;
  }

  /** Queues a part for ejection at the start of the next tick. Returns false if it cannot be ejected. */
  requestEject(uid: string): boolean {
    if (!this.canEject(uid)) return false;
    if (!this.pendingEject.includes(uid)) this.pendingEject.push(uid);
    return true;
  }

  /**
   * Parts that leave when `uid` is ejected: the part itself plus every part that would no longer be
   * structurally attached to the command module without it (intact or wrecked, conducting or not).
   * Sorted by uid; empty if the part cannot be ejected.
   */
  ejectionSet(uid: string): string[] {
    if (!this.canEject(uid)) return [];
    const root = this.parts.filter((p) => p.def.def.command).sort((a, b) => compareIds(a.uid, b.uid))[0];
    const adj = new Map<string, string[]>();
    for (const c of this.connections) {
      if (c.a === uid || c.b === uid) continue;
      (adj.get(c.a) ?? adj.set(c.a, []).get(c.a)!).push(c.b);
      (adj.get(c.b) ?? adj.set(c.b, []).get(c.b)!).push(c.a);
    }
    const kept = new Set<string>();
    const stack = root ? [root.uid] : [];
    while (stack.length) {
      const u = stack.pop()!;
      if (kept.has(u)) continue;
      kept.add(u);
      for (const v of adj.get(u) ?? []) if (!kept.has(v)) stack.push(v);
    }
    return this.parts
      .map((p) => p.uid)
      .filter((u) => !kept.has(u))
      .sort(compareIds);
  }

  /** Heat (J) that leaves with these parts: their share of the base pool by mass plus their own heat sinks. */
  heatShareOf(uids: readonly string[]): number {
    let own = 0;
    for (const uid of uids) {
      const p = this.part(uid);
      own +=
        HEAT.baseCapacity * (partMass(p) / this.massProps.mass) +
        (isIntact(p) ? (p.def.def.heatSink?.capacity ?? 0) : 0);
    }
    return this.heat * Math.min(1, own / this.heatCapacity);
  }

  /**
   * Removes parts from the ship (called by the world, which moves them into a debris body). Fuel, ammo
   * and their share of the heat leave with them; structure, networks and mass properties are recomputed.
   */
  removeParts(uids: readonly string[]): { parts: PartInstance[]; heat: number } {
    const parts = uids.map((u) => this.part(u));
    if (parts.some((p) => p.def.def.command)) throw new Error("Cannot eject a command module");
    const heat = this.heatShareOf(uids);
    this.heat -= heat;
    const gone = new Set(uids);
    for (const p of parts) {
      this.parts.splice(this.parts.indexOf(p), 1);
      this.byUid.delete(p.uid);
      this.activeWeapons.delete(p.uid);
      this.lastThrottle.delete(p.uid);
      this.powerFactors.delete(p.uid);
      this.reactorOutput.delete(p.uid);
    }
    this.pendingExplosions = this.pendingExplosions.filter((e) => !gone.has(e.uid));
    this.pendingShatter = this.pendingShatter.filter((u) => !gone.has(u));
    this.rebuildStructure();
    this.markNetworksDirty();
    this.updateNetworks();
    this.massProps = computeMassProps(this.parts);
    this.propsMass = this.massProps.mass;
    this.massRecomputes++;
    return { parts, heat };
  }

  /** Destroys a part: it becomes an inert wreck (keeps mass and shape) and networks are recomputed. */
  destroyPart(uid: string): void {
    const p = this.part(uid);
    if (p.hp > 0) this.onDestroyed(p);
    p.hp = 0;
  }

  /** Bookkeeping when a part goes from intact to wreck (exactly once). */
  private onDestroyed(p: PartInstance): void {
    p.hp = 0;
    this.markNetworksDirty();
    this.activeWeapons.delete(p.uid);
    this.queueExplosion(p);
  }

  private queueExplosion(p: PartInstance): void {
    const d = p.def.def;
    let e: { radius: number; damage: number } | null = null;
    if (d.fuelTank) e = storeBlast("fuelTank", p.fuel);
    else if (d.magazine) e = storeBlast("magazine", Math.floor(p.ammo) * d.magazine.massPerRound);
    else if (d.reactor && !d.command) e = EXPLOSION.reactor;
    if (e)
      this.pendingExplosions.push({
        uid: p.uid,
        center: partCentroid(p),
        radius: e.radius,
        damage: e.damage,
      });
  }

  /** Wrecks whose shadow life ran out; the world breaks them off at the end of the tick. */
  pendingShatter: string[] = [];

  /** Wears down a wreck's shadow life; at zero it is queued to break off (never the command module). */
  damageWreck(uid: string, damage: number): void {
    const p = this.part(uid);
    if (p.hp > 0 || damage <= 0 || p.wreckHp <= 0) return;
    p.wreckHp -= damage;
    if (p.wreckHp <= 0 && !p.def.def.command && !this.pendingShatter.includes(uid))
      this.pendingShatter.push(uid);
  }

  /**
   * Applies damage to a part (armor already applied by the caller). Returns true if this destroyed it.
   * Damage to a wreck goes to its shadow life.
   */
  applyDamage(uid: string, damage: number): boolean {
    const p = this.part(uid);
    if (p.hp <= 0) {
      this.damageWreck(uid, damage);
      return false;
    }
    if (damage <= 0) return false;
    if (p.hp - damage <= 0) {
      this.onDestroyed(p);
      return true;
    }
    p.hp -= damage;
    return false;
  }

  /** Blast damage to this ship's parts around a point (ship frame), falling off linearly with distance. */
  /**
   * Blast damage to intact parts within `radius` of `center` (ship frame), falling off linearly, after
   * armor. `factorOf` scales each part's share, e.g. for shelter behind wrecks.
   */
  applyBlast(
    center: Vec2,
    radius: number,
    damage: number,
    exceptUid?: string,
    factorOf?: (p: PartInstance, dist: number) => number,
  ): string[] {
    // Shares are worked out on the ship as it was when the blast began, so parts the blast destroys do
    // not shelter the parts behind them.
    const hits: { uid: string; dmg: number }[] = [];
    for (const p of [...this.parts].sort((a, b) => compareIds(a.uid, b.uid))) {
      if (p.uid === exceptUid) continue;
      const c = partCentroid(p);
      const dist = Math.hypot(c.x - center.x, c.y - center.y);
      if (dist >= radius) continue;
      const k = factorOf ? factorOf(p, dist) : 1;
      if (k <= 0) continue;
      hits.push({ uid: p.uid, dmg: afterArmor(damage * (1 - dist / radius) * k, p.def.def.armor ?? 0) });
    }
    const destroyed: string[] = [];
    // Wrecks in the blast lose shadow life (applyDamage routes it there).
    for (const h of hits) if (this.applyDamage(h.uid, h.dmg)) destroyed.push(h.uid);
    return destroyed;
  }

  addHeat(joules: number): void {
    this.pendingHeat += joules;
  }

  /** Served power fraction for a part's consumer role (1 if it needs no power). */
  powerFactorOf(uid: string): number {
    return consumerGroup(this.part(uid)) ? (this.powerFactors.get(uid) ?? 0) : 1;
  }

  /**
   * Defeat conditions (spec §8.1): command module destroyed, or no working propulsion AND no weapon able to fire.
   * Sets `defeated` once; it is never cleared.
   */
  evaluateDefeat(): boolean {
    if (this.defeated) return true;
    const cmd = this.parts.some((p) => p.def.def.command && p.hp > 0);
    if (!cmd) {
      this.defeated = true;
      this.defeatReason = "command-destroyed";
      return true;
    }
    this.updateNetworks();
    const canMove = this.parts.some(
      (p) =>
        p.hp > 0 &&
        (p.def.def.engine || p.def.def.thruster) &&
        this.isCommanded(p.uid) &&
        this.fuelInNetwork(this.networkOf(p.uid)) > 0,
    );
    const canFight = this.weapons.some((w) => {
      const p = w.part;
      if (p.hp <= 0 || !this.isCommanded(p.uid) || w.def.kind === "pd") return false;
      if (w.def.kind === "beam") return this.power.supply > 0;
      if (!w.def.ammoType) return true;
      if (p.ammo >= 1) return true;
      const net = this.networkOf(p.uid);
      return (this.networks.members[net!] ?? []).some((u) => {
        const m = this.byUid.get(u)!;
        return m.def.def.magazine?.ammoType === w.def.ammoType && m.ammo >= 1;
      });
    });
    // A hangar that still holds drones can still fight (spec §9.7).
    const canLaunch = this.parts.some(
      (p) => p.hp > 0 && p.def.def.hangar && p.ammo >= 1 && this.isCommanded(p.uid),
    );
    if (!canMove && !canFight && !canLaunch && this.liveDrones === 0) {
      this.defeated = true;
      this.defeatReason = "incapacitated";
    }
    return this.defeated;
  }

  /** Takes up to `n` rounds from a weapon's internal magazine (combat uses this from M4). Returns rounds fired. */
  drawRounds(uid: string, n: number): number {
    const p = this.part(uid);
    const take = Math.min(Math.floor(p.ammo + 1e-9), n);
    p.ammo -= take;
    return take;
  }

  /** True when mass changed beyond the threshold and props were recomputed. */
  maybeRecomputeMass(force = false): boolean {
    const mass = this.parts.reduce((s, p) => s + partMass(p), 0);
    if (!force && Math.abs(mass - this.propsMass) / this.propsMass <= MASS_RECOMPUTE_THRESHOLD) return false;
    this.massProps = computeMassProps(this.parts);
    this.propsMass = this.massProps.mass;
    this.massRecomputes++;
    return true;
  }

  collisionPieces(): { pieces: Vec2[][]; tag: string }[] {
    return this.parts.map((p) => ({ pieces: partPiecesShipFrame(p), tag: `${this.id}/${p.uid}` }));
  }

  // ---------- drones and hangars (spec §9.7) ----------
  /** H: every intact, commanded hangar queues all the drones it holds (optionally only some drone types). */
  requestDroneLaunch(only?: (droneType: string) => boolean): void {
    for (const p of [...this.parts].sort((a, b) => compareIds(a.uid, b.uid))) {
      if (!p.def.def.hangar || p.hp <= 0) continue;
      if (only && !only(p.def.def.hangar.droneType)) continue;
      this.hangarPending.set(p.uid, Math.floor(p.ammo));
    }
  }

  /**
   * Launches a single drone (H): the first intact hangar (by uid) that has a drone, nothing queued and its
   * launch cooldown over. Returns false when every hangar is empty or still cooling down.
   */
  launchOneDrone(only?: (droneType: string) => boolean): boolean {
    for (const p of [...this.parts].sort((a, b) => compareIds(a.uid, b.uid))) {
      const h = p.def.def.hangar;
      if (!h || p.hp <= 0 || p.ammo < 1 || (only && !only(h.droneType))) continue;
      if ((this.hangarPending.get(p.uid) ?? 0) > 0 || (this.hangarCooldown.get(p.uid) ?? 0) > 1e-9) continue;
      this.hangarPending.set(p.uid, 1);
      return true;
    }
    return false;
  }

  /** Seconds until any hangar can launch again (0 = ready now, Infinity = no drones left). */
  get droneCooldown(): number {
    let best = Infinity;
    for (const p of this.parts) {
      if (!p.def.def.hangar || p.hp <= 0 || p.ammo < 1) continue;
      const pending = (this.hangarPending.get(p.uid) ?? 0) > 0;
      best = Math.min(
        best,
        pending ? p.def.def.hangar.launchInterval : (this.hangarCooldown.get(p.uid) ?? 0),
      );
    }
    return best;
  }

  /** One hangar's state for the HUD: drones aboard, seconds until it can launch (0 = ready). */
  hangarState(uid: string): { stored: number; wait: number; pending: boolean } {
    const p = this.part(uid);
    const pending = (this.hangarPending.get(uid) ?? 0) > 0;
    return {
      stored: p.hp > 0 ? Math.floor(p.ammo) : 0,
      wait: pending ? (p.def.def.hangar?.launchInterval ?? 0) : (this.hangarCooldown.get(uid) ?? 0),
      pending,
    };
  }

  /** Drones left in hangars. */
  get dronesStored(): number {
    return this.parts.reduce((n, p) => n + (p.def.def.hangar && p.hp > 0 ? Math.floor(p.ammo) : 0), 0);
  }

  /** Strength of this ship as a decoy (0 when it is none or no longer active). */
  get decoyStrength(): number {
    if (this.inert || this.defeated) return 0;
    let s = 0;
    for (const p of this.parts) if (p.hp > 0 && p.def.def.decoy) s = Math.max(s, p.def.def.decoy.strength);
    return s;
  }

  /** Shortest decoy-emitter lifetime aboard (s), or null. */
  get decoyLifetime(): number | null {
    let t: number | null = null;
    for (const p of this.parts) if (p.def.def.decoy) t = Math.min(t ?? Infinity, p.def.def.decoy.lifetime);
    return t;
  }

  /** Makes a drone inert (no control, no weapons); the first reason sticks. */
  makeInert(reason: NonNullable<Ship["inertReason"]>): void {
    if (this.inert) return;
    this.inert = true;
    this.inertReason = reason;
    this.intent = IDLE_INTENT;
  }

  snapshot() {
    return {
      id: this.id,
      team: this.team,
      inert: this.inert,
      pdEngageShips: this.pdEngageShips,
      drone: this.drone,
      hangars: [...this.hangarPending].map(([uid, n]) => [uid, n, this.hangarCooldown.get(uid) ?? 0]),
      speedKill: this.flight.speedKill,
      heat: this.heat,
      radiatorsExtended: this.radiatorsExtended,
      defeated: this.defeated,
      weapons: this.weapons.map((w) => ({ uid: w.uid, turret: w.turret, cooldown: w.cooldown })),
      powerPriority: this.powerPriority,
      parts: this.parts.map((p) => ({
        uid: p.uid,
        hp: p.hp,
        wreckHp: p.wreckHp,
        fuel: p.fuel,
        charge: p.charge,
        ammo: p.ammo,
      })),
      throttles: this.throttles,
    };
  }
}
