import { World as PWorld, Polygon, Circle, Settings, type Body } from "planck";
import type { Vec2 } from "../core/vec2";
import { compareIds } from "../core/ids";

// Box2D defaults cap movement at 2 m per step (120 m/s at 60 Hz), far too slow for space combat.
Settings.maxTranslation = 1000;

/**
 * Thin boundary around Planck.js (implementation plan M0 task 9). The rest of /sim never imports planck.
 * Gravity is zero: gravity wells are applied by the game as forces (spec §6.9).
 */
export type BodyType = "dynamic" | "static" | "kinematic";

export interface BodyDef {
  readonly id: string;
  readonly type: BodyType;
  readonly position: Vec2;
  readonly angle: number;
  readonly linearVelocity?: Vec2;
  readonly angularVelocity?: number;
}

export interface PolygonFixtureDef {
  readonly vertices: readonly Vec2[];
  readonly density?: number;
  readonly friction?: number;
  readonly restitution?: number;
  /** Owner tag, e.g. a part instance uid. */
  readonly tag?: string;
}

/** Mass properties computed by the game (spec §6.1). `inertia` is about the centre of mass. */
export interface MassProps {
  readonly mass: number;
  readonly center: Vec2; // body-local
  readonly inertia: number;
}

export interface BodyState {
  readonly id: string;
  readonly position: Vec2;
  readonly angle: number;
  readonly linearVelocity: Vec2;
  readonly angularVelocity: number;
}

const VELOCITY_ITERATIONS = 8;
const POSITION_ITERATIONS = 3;

/** Summed normal impulse between two fixtures during one step (N·s); tags as given to addPolygon. */
export interface ContactImpulse {
  readonly tagA: string;
  readonly tagB: string;
  readonly impulse: number;
}

export class PhysicsWorld {
  private readonly world = new PWorld({ gravity: { x: 0, y: 0 } });
  private readonly bodies = new Map<string, Body>();
  private contactSums = new Map<string, { tagA: string; tagB: string; impulse: number }>();

  constructor() {
    this.world.on("post-solve", (contact, impulse) => {
      const a = contact.getFixtureA().getUserData() as string | undefined;
      const b = contact.getFixtureB().getUserData() as string | undefined;
      if (!a || !b) return;
      const [tagA, tagB] = a < b ? [a, b] : [b, a];
      const key = `${tagA}|${tagB}`;
      const j = impulse.normalImpulses.reduce((sum, x) => sum + x, 0);
      const cur = this.contactSums.get(key);
      if (cur) cur.impulse += j;
      else this.contactSums.set(key, { tagA, tagB, impulse: j });
    });
  }

  /** Contact impulses of the last step, sorted by tag (deterministic), then cleared. */
  takeContactImpulses(): ContactImpulse[] {
    const out = [...this.contactSums.values()].sort((x, y) =>
      x.tagA < y.tagA ? -1 : x.tagA > y.tagA ? 1 : x.tagB < y.tagB ? -1 : 1,
    );
    this.contactSums = new Map();
    return out;
  }

  createBody(def: BodyDef): void {
    if (this.bodies.has(def.id)) throw new Error(`Duplicate body id ${def.id}`);
    const body = this.world.createBody({
      type: def.type,
      position: { x: def.position.x, y: def.position.y },
      angle: def.angle,
      linearVelocity: def.linearVelocity
        ? { x: def.linearVelocity.x, y: def.linearVelocity.y }
        : { x: 0, y: 0 },
      angularVelocity: def.angularVelocity ?? 0,
      allowSleep: false,
    });
    this.bodies.set(def.id, body);
  }

  destroyBody(id: string): void {
    this.world.destroyBody(this.get(id));
    this.bodies.delete(id);
  }

  /** Removes every fixture with this tag from a body. Call setMassProps afterwards (Planck resets mass). */
  removeFixtures(bodyId: string, tag: string): void {
    const body = this.get(bodyId);
    const doomed = [];
    for (let f = body.getFixtureList(); f; f = f.getNext()) if (f.getUserData() === tag) doomed.push(f);
    for (const f of doomed) body.destroyFixture(f);
  }

  addPolygon(bodyId: string, def: PolygonFixtureDef): void {
    this.get(bodyId).createFixture({
      shape: new Polygon(def.vertices.map((v) => ({ x: v.x, y: v.y }))),
      density: def.density ?? 1,
      friction: def.friction ?? 0.3,
      restitution: def.restitution ?? 0.1,
      userData: def.tag,
    });
  }

  addCircle(bodyId: string, center: Vec2, radius: number, tag?: string): void {
    this.get(bodyId).createFixture({
      shape: new Circle({ x: center.x, y: center.y }, radius),
      density: 1,
      friction: 0.4,
      restitution: 0.2,
      userData: tag,
    });
  }

  /** Ids of dynamic bodies, sorted. */
  dynamicBodyIds(): string[] {
    return [...this.bodies.entries()]
      .filter(([, b]) => b.isDynamic())
      .map(([id]) => id)
      .sort(compareIds);
  }

  hasBody(id: string): boolean {
    return this.bodies.has(id);
  }

  /** World position of the body's centre of mass. */
  getWorldCenter(id: string): Vec2 {
    const c = this.get(id).getWorldCenter();
    return { x: c.x, y: c.y };
  }

  /** Override fixture-derived mass with game-computed values. Planck expects inertia about the body origin. */
  setMassProps(bodyId: string, m: MassProps): void {
    const c = m.center;
    this.get(bodyId).setMassData({
      mass: m.mass,
      center: { x: c.x, y: c.y },
      I: m.inertia + m.mass * (c.x * c.x + c.y * c.y),
    });
  }

  /** Sets the velocity of the body's centre of mass (m/s). */
  setLinearVelocity(bodyId: string, v: Vec2): void {
    this.get(bodyId).setLinearVelocity({ x: v.x, y: v.y });
  }

  getMassProps(bodyId: string): MassProps {
    const b = this.get(bodyId);
    const c = b.getLocalCenter();
    return {
      mass: b.getMass(),
      center: { x: c.x, y: c.y },
      inertia: b.getInertia() - b.getMass() * (c.x * c.x + c.y * c.y),
    };
  }

  applyForce(bodyId: string, force: Vec2, worldPoint: Vec2): void {
    this.get(bodyId).applyForce({ x: force.x, y: force.y }, { x: worldPoint.x, y: worldPoint.y }, true);
  }

  applyForceToCenter(bodyId: string, force: Vec2): void {
    this.get(bodyId).applyForceToCenter({ x: force.x, y: force.y }, true);
  }

  applyImpulse(bodyId: string, impulse: Vec2, worldPoint: Vec2): void {
    this.get(bodyId).applyLinearImpulse(
      { x: impulse.x, y: impulse.y },
      { x: worldPoint.x, y: worldPoint.y },
      true,
    );
  }

  /** World velocity of a point attached to the body. */
  velocityAt(bodyId: string, worldPoint: Vec2): Vec2 {
    const v = this.get(bodyId).getLinearVelocityFromWorldPoint({ x: worldPoint.x, y: worldPoint.y });
    return { x: v.x, y: v.y };
  }

  applyTorque(bodyId: string, torque: number): void {
    this.get(bodyId).applyTorque(torque, true);
  }

  step(dt: number): void {
    this.contactSums = new Map();
    this.world.step(dt, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
  }

  getBodyState(id: string): BodyState {
    const b = this.get(id);
    const p = b.getPosition();
    const v = b.getLinearVelocity();
    return {
      id,
      position: { x: p.x, y: p.y },
      angle: b.getAngle(),
      linearVelocity: { x: v.x, y: v.y },
      angularVelocity: b.getAngularVelocity(),
    };
  }

  /** All body states sorted by id, for deterministic snapshots and hashing. */
  getState(): BodyState[] {
    return [...this.bodies.keys()].sort(compareIds).map((id) => this.getBodyState(id));
  }

  private get(id: string): Body {
    const b = this.bodies.get(id);
    if (!b) throw new Error(`Unknown body ${id}`);
    return b;
  }
}
