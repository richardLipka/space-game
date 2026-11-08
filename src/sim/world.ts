import type { ShipDesign } from "../data/schemas/design";
import { Rng } from "./core/rng";
import { IdGenerator, compareIds } from "./core/ids";
import { SIM_DT } from "./core/loop";
import { hashState } from "./core/hash";
import { type Vec2, add, length, normalize, rotate, scale, sub, ZERO } from "./core/vec2";
import { PhysicsWorld } from "./physics/planck-adapter";
import { accelToForce, boundaryAccel, gravityAccel } from "./physics/forces";
import type { PartCatalogue } from "./ship/catalogue";
import {
  computeMassProps,
  instantiateParts,
  partPiecesShipFrame,
  type InstantiateOptions,
} from "./ship/ship";
import { transformPoints } from "./core/geometry";
import { Ship } from "./ship/ship-entity";
import type { ControlIntent } from "./flight/controller";
import {
  applyContactDamage,
  CombatState,
  fireWeapons,
  processExplosions,
  pruneEvents,
  stepProjectiles,
} from "./combat/combat-world";
import { stepMissiles } from "./combat/missiles";
import { controlDrones, launchDrones, updateDroneLinks } from "./drones/drones";

export interface WorldConfig {
  readonly seed: number;
  /** Defeated ships lose control and stop firing (spec §8.1). Scenarios and test flights enable it. */
  readonly enforceDefeat?: boolean;
}

export interface Arena {
  readonly width: number;
  readonly height: number;
}

export interface GravityWellState {
  readonly position: Vec2;
  readonly mu: number;
  readonly softening: number;
  readonly coreRadius: number;
  readonly cutoffRadius?: number | undefined;
}

/** One part of a debris cluster, as it was on the ship. */
export interface DebrisPiece {
  readonly uid: string;
  readonly partId: string;
  readonly category: string;
  /** Outline in the debris body's frame (= the ship's frame when it was ejected). */
  readonly outline: readonly Vec2[];
  /** Whether it was a wreck (destroyed) when ejected. */
  readonly wreck: boolean;
}

/**
 * A jettisoned part plus everything that was attached to the ship only through it, drifting free as one
 * rigid body (decision log: Ejection). Inert: it blocks shots and can collide.
 */
export interface Debris {
  readonly id: string;
  /** Ship it came from. */
  readonly ship: string;
  /** The part the pilot ejected. */
  readonly uid: string;
  readonly pieces: readonly DebrisPiece[];
  /** Largest distance of any outline point from the body origin (m), for cheap ray rejection. */
  readonly radius: number;
  readonly tick: number;
}

/** Ejection tuning: separation speed (m/s) and the most debris bodies kept (oldest are removed). */
export const EJECT = { speed: 3, maxDebris: 200 } as const;

export interface SpawnOptions extends InstantiateOptions {
  readonly position?: Vec2;
  /** Radians. */
  readonly angle?: number;
  readonly velocity?: Vec2;
  readonly angularVelocity?: number;
  readonly team?: number;
}

/** Root simulation object. Advances only in fixed ticks; no wall-clock or DOM access (spec §13.4). */
export class World {
  tick = 0;
  readonly seed: number;
  readonly rng: Rng;
  readonly ids = new IdGenerator();
  readonly physics = new PhysicsWorld();
  arena: Arena | null = null;
  readonly gravityWells: GravityWellState[] = [];
  /** Asteroid geometry (body-local outlines) for rendering and later hit tests. */
  readonly asteroids: { readonly id: string; readonly outline: readonly Vec2[] }[] = [];
  private readonly ships = new Map<string, Ship>();
  private readonly catalogues = new Map<string, PartCatalogue>();
  /** Designs hangars can launch (drone types, spec §9.7), by design id. */
  readonly designs = new Map<string, ShipDesign>();
  /** Jettisoned parts, oldest first. */
  debris: Debris[] = [];

  readonly combat = new CombatState();
  enforceDefeat: boolean;

  constructor(config: WorldConfig) {
    this.seed = config.seed;
    this.rng = new Rng(config.seed);
    this.enforceDefeat = config.enforceDefeat ?? false;
  }

  hasShip(id: string): boolean {
    return this.ships.has(id);
  }

  get time(): number {
    return this.tick * SIM_DT;
  }

  /** Makes a design available to hangars (drone types). */
  registerDesign(design: ShipDesign): void {
    this.designs.set(design.id, design);
  }

  /** Part catalogue a ship was built from (drones launched from it use the same one). */
  catalogueOf(shipId: string): PartCatalogue {
    const c = this.catalogues.get(shipId);
    if (!c) throw new Error(`Unknown ship ${shipId}`);
    return c;
  }

  addShip(design: ShipDesign, catalogue: PartCatalogue, options: SpawnOptions = {}): Ship {
    const id = this.ids.next("ship");
    this.catalogues.set(id, catalogue);
    const ship = new Ship(id, design, instantiateParts(design, catalogue, options), options.team ?? 0);
    this.physics.createBody({
      id,
      type: "dynamic",
      position: options.position ?? ZERO,
      angle: options.angle ?? 0,
      linearVelocity: options.velocity,
      angularVelocity: options.angularVelocity,
    });
    for (const { pieces, tag } of ship.collisionPieces()) {
      for (const piece of pieces) this.physics.addPolygon(id, { vertices: piece, density: 1, tag });
    }
    this.physics.setMassProps(id, ship.massProps);
    this.ships.set(id, ship);
    this.sortedShips = null;
    return ship;
  }

  addGravityWell(well: GravityWellState): void {
    this.gravityWells.push(well);
    const id = this.ids.next("well");
    this.physics.createBody({ id, type: "static", position: well.position, angle: 0 });
    this.physics.addCircle(id, ZERO, well.coreRadius, id);
  }

  getShip(id: string): Ship {
    const s = this.ships.get(id);
    if (!s) throw new Error(`Unknown ship ${id}`);
    return s;
  }

  private sortedShips: Ship[] | null = null;

  /** Ships sorted by id (deterministic iteration). Cached until a ship is added; callers must not mutate it. */
  allShips(): readonly Ship[] {
    return (this.sortedShips ??= [...this.ships.values()].sort((a, b) => compareIds(a.id, b.id)));
  }

  setIntent(shipId: string, intent: ControlIntent): void {
    this.getShip(shipId).intent = intent;
  }

  /**
   * Jettisons a part (decision log: Ejection): it leaves as a separate debris body pushed away from the
   * ship at EJECT.speed, with an equal and opposite push on the ship. Fuel, ammo and its heat go with it.
   */
  ejectPart(shipId: string, uid: string): Debris | null {
    const ship = this.getShip(shipId);
    const uids = ship.ejectionSet(uid);
    if (uids.length === 0) return null;
    const pose = this.physics.getBodyState(shipId);
    const shipCenter = this.physics.getWorldCenter(shipId);
    const leaving = uids.map((u) => ship.part(u));
    const local = computeMassProps(leaving).center;
    const worldAt = add(pose.position, rotate(local, pose.angle));
    const vAt = this.physics.velocityAt(shipId, worldAt);
    const away = sub(worldAt, shipCenter);
    const dir = length(away) > 1e-6 ? normalize(away) : rotate({ x: 0, y: 1 }, pose.angle);
    const shapes = leaving.flatMap((p) => partPiecesShipFrame(p));
    const pieces: DebrisPiece[] = leaving.map((p) => ({
      uid: p.uid,
      partId: p.def.id,
      category: p.def.def.category,
      outline: transformPoints(p.def.outline, p.angle, p.position),
      wreck: p.hp <= 0,
    }));
    const radius = Math.max(...pieces.flatMap((pc) => pc.outline.map((v) => length(v))));
    const { parts } = ship.removeParts(uids);
    for (const u of uids) this.physics.removeFixtures(shipId, `${shipId}/${u}`);
    this.physics.setMassProps(shipId, ship.massProps);

    const id = this.ids.next("debris");
    this.physics.createBody({
      id,
      type: "dynamic",
      position: pose.position,
      angle: pose.angle,
      linearVelocity: add(vAt, scale(dir, EJECT.speed)),
      angularVelocity: pose.angularVelocity,
    });
    for (const shape of shapes) this.physics.addPolygon(id, { vertices: shape, density: 1, tag: id });
    const mp = computeMassProps(parts);
    this.physics.setMassProps(id, mp);
    // Planck shifts the velocity when the centre moves; the cluster's centre keeps the velocity it had on the ship.
    this.physics.setLinearVelocity(id, add(vAt, scale(dir, EJECT.speed)));
    this.physics.applyImpulse(shipId, scale(dir, -mp.mass * EJECT.speed), worldAt);
    const d: Debris = { id, ship: shipId, uid, pieces, radius, tick: this.tick };
    this.debris.push(d);
    while (this.debris.length > EJECT.maxDebris) this.physics.destroyBody(this.debris.shift()!.id);
    this.combat.events.push({ tick: this.tick, kind: "eject", pos: worldAt, size: 1 });
    return d;
  }

  step(): void {
    const dt = SIM_DT;
    // 0: ejections requested by pilots since the last tick.
    for (const ship of this.allShips()) {
      const queued = ship.pendingEject;
      ship.pendingEject = [];
      for (const uid of queued) this.ejectPart(ship.id, uid);
    }
    // 0b–0d: drones (spec §9.7): launches, link checks, drone AI.
    launchDrones(this, dt);
    updateDroneLinks(this, dt);
    controlDrones(this);
    // 1–6: control, fuel, apply ship forces (plan §13.3).
    // 2–3: networks and power.
    for (const ship of this.allShips()) ship.preStep(dt);
    for (const ship of this.allShips()) {
      const s = this.physics.getBodyState(ship.id);
      const w = ship.control({
        angle: s.angle,
        angularVelocity: s.angularVelocity,
        velocity: s.linearVelocity,
        dt,
        disabled: (this.enforceDefeat && ship.defeated) || ship.inert,
      });
      const f = rotate({ x: w.fx, y: w.fy }, s.angle);
      if (f.x !== 0 || f.y !== 0) this.physics.applyForceToCenter(ship.id, f);
      if (w.torque !== 0) this.physics.applyTorque(ship.id, w.torque);
    }
    // Environment forces on every dynamic body: gravity wells and arena boundary.
    if (this.gravityWells.length > 0 || this.arena) {
      for (const id of this.physics.dynamicBodyIds()) {
        const pos = this.physics.getWorldCenter(id);
        const g = gravityAccel(this.gravityWells, pos);
        const b = boundaryAccel(this.arena, pos);
        const a = { x: g.x + b.x, y: g.y + b.y };
        if (a.x !== 0 || a.y !== 0)
          this.physics.applyForceToCenter(id, accelToForce(a, this.physics.getMassProps(id).mass));
      }
    }
    // 9: weapons aim and fire (poses before the physics step).
    fireWeapons(this, dt);
    // 7: physics step.
    this.physics.step(dt);
    // 8: collision damage; 10: projectiles.
    applyContactDamage(this, this.physics.takeContactImpulses());
    stepProjectiles(this, dt);
    stepMissiles(this, dt);
    processExplosions(this);
    // 11–12: heat, overheat damage, ammo refill.
    for (const ship of this.allShips()) ship.postStep(dt);
    processExplosions(this);
    // 13: mass properties after fuel and ammo use.
    for (const ship of this.allShips()) {
      if (ship.maybeRecomputeMass()) this.physics.setMassProps(ship.id, ship.massProps);
    }
    // 14: defeat checks.
    for (const ship of this.allShips()) ship.evaluateDefeat();
    pruneEvents(this);
    this.tick++;
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  snapshot() {
    return {
      tick: this.tick,
      seed: this.seed,
      rng: [...this.rng.getState()],
      ids: this.ids.getState(),
      bodies: this.physics.getState(),
      ships: this.allShips().map((s) => s.snapshot()),
      debris: this.debris.map((d) => d.id),
      projectiles: this.combat.projectiles.map((p) => ({
        id: p.id,
        owner: p.owner,
        pos: p.pos,
        vel: p.vel,
        age: p.age,
      })),
      missiles: this.combat.missiles.map((m) => ({
        id: m.id,
        pos: m.pos,
        vel: m.vel,
        heading: m.heading,
        fuel: m.fuel,
        hp: m.hp,
        target: m.target,
      })),
    };
  }

  hash(): string {
    return hashState(this.snapshot());
  }
}
