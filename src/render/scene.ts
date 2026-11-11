import { Application, Container, Graphics } from "pixi.js";
import type { World } from "../sim/world";
import type { Ship } from "../sim/ship/ship-entity";
import { partCentroid, toShipDir } from "../sim/ship/ship";
import { type Vec2, add, length, rotate, scale } from "../sim/core/vec2";
import type { Camera } from "./camera";
import type { DrawStyle, ThemeResolver } from "./theme";

interface Pose {
  x: number;
  y: number;
  angle: number;
}

interface ShipView {
  root: Container;
  hull: Graphics;
  fx: Graphics;
  overlay: Graphics;
  radius: number;
  themeVersion: number;
  stateKey: string;
}

const lerpAngle = (a: number, b: number, t: number): number => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};

function strokeStyled(g: Graphics, s: DrawStyle, zoom: number): void {
  if (s.glowAlpha > 0 && s.glowWidth > 0)
    g.stroke({ width: s.glowWidth / zoom, color: s.glow, alpha: s.glowAlpha, join: "round", cap: "round" });
  g.stroke({
    width: s.strokeWidth / zoom,
    color: s.stroke,
    alpha: s.strokeAlpha,
    join: "round",
    cap: "round",
  });
}

function polyStyled(g: Graphics, pts: readonly Vec2[], s: DrawStyle, zoom: number): void {
  const flat = pts.flatMap((p) => [p.x, p.y]);
  g.poly(flat, true);
  if (s.fillAlpha > 0) g.fill({ color: s.fill, alpha: s.fillAlpha });
  strokeStyled(g, s, zoom);
}

/** Projected course: how far ahead (s), the spacing of the time dots (s) and the line resolution (s). */
export const COURSE_HORIZON = 10;
const COURSE_DOT_EVERY = 1;
const COURSE_STEP = 0.25;
/** Smoothing of the measured acceleration per tick (thrusters pulse, so the raw value jitters). */
const COURSE_ACCEL_SMOOTHING = 0.1;

/** Heat level at which radiators glow at full strength. */
const RADIATOR_GLOW_FULL = 0.8;

/**
 * Pixi renderer. Reads world state only; never mutates the simulation (spec §13.2).
 * Static geometry (hulls, asteroids) is built once per ship and rebuilt when the theme or zoom bucket changes.
 */
export class Scene {
  /** Root container of this scene on the shared Pixi stage. */
  readonly root = new Container();
  private readonly worldLayer = new Container();
  private readonly gridG = new Graphics();
  /** Parent of the asteroid and debris graphics (a Container: Pixi 8 deprecates children on Graphics). */
  private readonly staticG = new Container();
  private readonly screenG = new Graphics();
  private readonly ships = new Map<string, ShipView>();
  private readonly asteroidViews = new Map<string, { g: Graphics; zoomKey: number; themeVersion: number }>();
  private prev = new Map<string, Pose>();
  private curr = new Map<string, Pose>();
  showOverlays = true;
  /** Colour parts by resource network (spec §7.1); the command network is net-0. */
  showNetworks = false;
  /** Selected target ship (drawn with a marker). */
  targetId: string | null = null;
  /** Ships whose projected course is drawn (the pilot's ship and its target). */
  courseIds: readonly string[] = [];
  /** Per tracked ship: last centre velocity and the smoothed measured acceleration. */
  private readonly motion = new Map<string, { v: Vec2; a: Vec2 }>();
  /** Eject mode (decision log: Ejection): the pilot's ship and the part under the cursor. */
  eject: { shipId: string; hoverUid: string | null } | null = null;
  private readonly debrisViews = new Map<string, { g: Graphics; zoomKey: number; themeVersion: number }>();
  private readonly fxG = new Graphics();

  constructor(
    private readonly theme: ThemeResolver,
    readonly app: Application,
  ) {
    this.worldLayer.addChild(this.gridG, this.staticG);
    this.root.addChild(this.worldLayer, this.screenG);
    this.worldLayer.addChild(this.fxG);
    app.stage.addChild(this.root);
  }

  /** Removes this scene from the stage and frees its GPU resources. */
  destroy(): void {
    this.root.destroy({ children: true });
  }

  /** Record poses at a tick boundary (call before each world.step) for interpolation. */
  capture(world: World): void {
    this.prev = this.curr;
    this.curr = new Map();
    for (const b of world.physics.getState())
      this.curr.set(b.id, { x: b.position.x, y: b.position.y, angle: b.angle });
    this.trackMotion(world);
  }

  /** Measures each course ship's acceleration from its velocity change over the last tick (thrust and gravity). */
  private trackMotion(world: World): void {
    const dt = 1 / 60;
    for (const id of this.motion.keys())
      if (!this.courseIds.includes(id) || !world.hasShip(id)) this.motion.delete(id);
    for (const id of this.courseIds) {
      if (!world.hasShip(id)) continue;
      const v = world.physics.velocityAt(id, world.physics.getWorldCenter(id));
      const m = this.motion.get(id);
      if (!m) {
        this.motion.set(id, { v, a: { x: 0, y: 0 } });
        continue;
      }
      const k = COURSE_ACCEL_SMOOTHING;
      m.a = {
        x: m.a.x + ((v.x - m.v.x) / dt - m.a.x) * k,
        y: m.a.y + ((v.y - m.v.y) / dt - m.a.y) * k,
      };
      m.v = v;
    }
  }

  /** Where a course ship will be after t seconds at its current velocity and acceleration (null if untracked). */
  projectedPosition(id: string, world: World, t: number, from?: Vec2): Vec2 | null {
    const m = this.motion.get(id);
    if (!m || !world.hasShip(id)) return null;
    const p = from ?? world.physics.getWorldCenter(id);
    return { x: p.x + m.v.x * t + 0.5 * m.a.x * t * t, y: p.y + m.v.y * t + 0.5 * m.a.y * t * t };
  }

  private pose(id: string, world: World, alpha: number): Pose {
    const c = this.curr.get(id);
    const p = this.prev.get(id);
    if (!c) {
      const s = world.physics.getBodyState(id);
      return { x: s.position.x, y: s.position.y, angle: s.angle };
    }
    if (!p) return c;
    return {
      x: p.x + (c.x - p.x) * alpha,
      y: p.y + (c.y - p.y) * alpha,
      angle: lerpAngle(p.angle, c.angle, alpha),
    };
  }

  /** Interpolated world position of a ship's centre of mass. */
  shipCenter(ship: Ship, world: World, alpha: number): Vec2 {
    const p = this.pose(ship.id, world, alpha);
    return add({ x: p.x, y: p.y }, rotate(ship.massProps.center, p.angle));
  }

  render(world: World, camera: Camera, alpha: number): void {
    const z = camera.zoom;
    this.worldLayer.position.set(camera.cx - camera.center.x * z, camera.cy + camera.center.y * z);
    this.worldLayer.scale.set(z, -z);
    this.drawGrid(world, camera);
    this.drawAsteroids(world, camera, alpha);
    this.drawDebris(world, camera, alpha);
    this.screenG.clear();
    for (const ship of world.allShips()) this.drawShip(ship, world, camera, alpha);
    // Keep effects above ship hulls.
    this.worldLayer.addChild(this.fxG);
    this.drawCombat(world, camera, alpha);
    if (this.showOverlays) this.drawAiDebug(world, camera);
    if (this.showOverlays) this.drawCourses(world, camera, alpha);
    this.drawOffscreenIndicators(world, camera, alpha);
  }

  /** AI debug view (plan M6 task 8): each AI ship's desired velocity as a line from its centre (1 s ahead). */
  private drawAiDebug(world: World, camera: Camera): void {
    if (world.ai.size === 0) return;
    const g = this.fxG;
    const s = this.theme.resolve("overlay-ai-velocity");
    for (const [id, st] of world.ai) {
      if (!world.hasShip(id)) continue;
      const c = world.physics.getWorldCenter(id);
      const v = st.debug.desiredVel;
      g.moveTo(c.x, c.y).lineTo(c.x + v.x, c.y + v.y);
    }
    strokeStyled(g, s, camera.zoom);
  }

  /**
   * Projected course of the pilot's ship and its target: where each will be over the next seconds if it keeps
   * its current velocity and acceleration, as a thin line with a dot every second.
   */
  private drawCourses(world: World, camera: Camera, alpha: number): void {
    const g = this.fxG;
    const z = camera.zoom;
    for (const id of this.courseIds) {
      const ship = world.allShips().find((s) => s.id === id);
      if (!ship || !this.motion.has(id)) continue;
      const start = this.shipCenter(ship, world, alpha);
      const style = this.theme.resolve(`overlay-course${id === this.targetId ? " target" : ""}`);
      const steps = Math.round(COURSE_HORIZON / COURSE_STEP);
      g.moveTo(start.x, start.y);
      for (let i = 1; i <= steps; i++) {
        const p = this.projectedPosition(id, world, i * COURSE_STEP, start)!;
        g.lineTo(p.x, p.y);
      }
      strokeStyled(g, style, z);
      const r = Math.max(style.minSize, 1.5) / z;
      for (let t = COURSE_DOT_EVERY; t <= COURSE_HORIZON + 1e-9; t += COURSE_DOT_EVERY) {
        const p = this.projectedPosition(id, world, t, start)!;
        g.circle(p.x, p.y, t === COURSE_HORIZON ? r * 1.6 : r);
      }
      g.fill({ color: style.stroke, alpha: style.strokeAlpha });
    }
  }

  /** Projectiles, beams, effects and the target marker (spec §9, §13.7). */
  private drawCombat(world: World, camera: Camera, alpha: number): void {
    const g = this.fxG;
    const z = camera.zoom;
    g.clear();
    const dt = 1 / 60;
    // Projectile tracers, interpolated within the tick.
    const byKind = new Map<string, { x: number; y: number; tx: number; ty: number }[]>();
    for (const p of world.combat.projectiles) {
      const back = (1 - alpha) * dt;
      const x = p.pos.x - p.vel.x * back;
      const y = p.pos.y - p.vel.y * back;
      const sp = Math.hypot(p.vel.x, p.vel.y) || 1;
      const style = this.theme.resolve(`fx-projectile kind-${p.kind}`);
      const len = Math.max(style.minSize / z, sp * 0.012 * style.scale);
      const list = byKind.get(p.kind) ?? [];
      list.push({ x, y, tx: x - (p.vel.x / sp) * len, ty: y - (p.vel.y / sp) * len });
      byKind.set(p.kind, list);
    }
    for (const [kind, list] of byKind) {
      for (const t of list) g.moveTo(t.tx, t.ty).lineTo(t.x, t.y);
      strokeStyled(g, this.theme.resolve(`fx-projectile kind-${kind}`), z);
    }
    // Missiles (spec §9.5): an arrowhead along the heading, with an exhaust trail while burning.
    for (const m of world.combat.missiles) {
      const back = (1 - alpha) * dt;
      const x = m.pos.x - m.vel.x * back;
      const y = m.pos.y - m.vel.y * back;
      const body = this.theme.resolve(`missile team-${m.team}`);
      const size = Math.max(body.minSize / z, 1.6);
      const hx = Math.cos(m.heading);
      const hy = Math.sin(m.heading);
      if (m.fuel > 0) {
        const ex = this.theme.resolve("fx-missile-exhaust");
        const len = size * 2.5 * ex.scale;
        g.moveTo(x - hx * size * 0.6, y - hy * size * 0.6).lineTo(
          x - hx * (size * 0.6 + len),
          y - hy * (size * 0.6 + len),
        );
        strokeStyled(g, ex, z);
      }
      g.poly(
        [
          x + hx * size,
          y + hy * size,
          x - hx * size * 0.6 - hy * size * 0.5,
          y - hy * size * 0.6 + hx * size * 0.5,
          x - hx * size * 0.6 + hy * size * 0.5,
          y - hy * size * 0.6 - hx * size * 0.5,
        ],
        true,
      );
      if (body.fillAlpha > 0) g.fill({ color: body.fill, alpha: body.fillAlpha });
      strokeStyled(g, body, z);
    }
    // Beams fired this tick.
    if (world.combat.beams.length) {
      for (const b of world.combat.beams) g.moveTo(b.from.x, b.from.y).lineTo(b.to.x, b.to.y);
      strokeStyled(g, this.theme.resolve("fx-beam"), z);
    }
    // Short-lived effects.
    const now = world.tick + alpha;
    for (const e of world.combat.events) {
      const age = (now - e.tick) * dt;
      const life =
        e.kind === "explosion"
          ? 0.8
          : e.kind === "fire"
            ? 0.08
            : e.kind === "beam-hit"
              ? 0.15
              : e.kind === "destroyed"
                ? 0.6
                : 0.3;
      if (age < 0 || age > life) continue;
      const k = 1 - age / life;
      const s = this.theme.resolve(`fx-${e.kind}`);
      const r =
        e.kind === "explosion"
          ? e.size * (0.3 + 0.9 * (1 - k))
          : e.kind === "destroyed"
            ? 1 + 2 * (1 - k)
            : e.size * (0.4 + 0.6 * (1 - k));
      g.circle(e.pos.x, e.pos.y, Math.max(r, s.minSize / z));
      if (s.fillAlpha > 0) g.fill({ color: s.fill, alpha: s.fillAlpha * k });
      g.stroke({ width: s.strokeWidth / z, color: s.stroke, alpha: s.strokeAlpha * k });
    }
    // Target marker: corner brackets around the target ship.
    if (this.targetId && world.hasShip(this.targetId)) {
      const t = world.getShip(this.targetId);
      const c = world.physics.getWorldCenter(t.id);
      const s = this.theme.resolve(`overlay-target${t.defeated ? " defeated" : ""}`);
      const r = Math.max(t.layout.boundingRadius * 1.25, s.minSize / z);
      const q = r * 0.4;
      for (const [sx, sy] of [
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ] as const) {
        g.moveTo(c.x + sx * r, c.y + sy * (r - q))
          .lineTo(c.x + sx * r, c.y + sy * r)
          .lineTo(c.x + sx * (r - q), c.y + sy * r);
      }
      strokeStyled(g, s, z);
    }
  }

  /** Edge markers for ships outside the view (spec §10.1). */
  private drawOffscreenIndicators(world: World, camera: Camera, alpha: number): void {
    const m = 14;
    // Indicators sit on the edge of the view left free by the HUD panels.
    const cx = camera.cx;
    const cy = camera.cy;
    const hw = camera.viewWidth / 2;
    const hh = camera.viewHeight / 2;
    for (const ship of world.allShips()) {
      const p = camera.worldToScreen(this.shipCenter(ship, world, alpha));
      if (Math.abs(p.x - cx) <= hw && Math.abs(p.y - cy) <= hh) continue;
      const dx = p.x - cx;
      const dy = p.y - cy;
      const k = Math.min((hw - m) / Math.abs(dx || 1e-9), (hh - m) / Math.abs(dy || 1e-9));
      const ex = cx + dx * k;
      const ey = cy + dy * k;
      const a = Math.atan2(dy, dx);
      const s = this.theme.resolve(`icon-ship team-${ship.team}`);
      const r = s.minSize * 1.4;
      this.screenG.poly(
        [
          ex + Math.cos(a) * r,
          ey + Math.sin(a) * r,
          ex + Math.cos(a + 2.5) * r,
          ey + Math.sin(a + 2.5) * r,
          ex + Math.cos(a - 2.5) * r,
          ey + Math.sin(a - 2.5) * r,
        ],
        true,
      );
      strokeStyled(this.screenG, s, 1);
    }
  }

  private drawGrid(world: World, camera: Camera): void {
    const g = this.gridG;
    const z = camera.zoom;
    g.clear();
    const minor = Math.pow(10, Math.ceil(Math.log10(40 / z)));
    const major = minor * 10;
    const tl = camera.screenToWorld({ x: 0, y: 0 });
    const br = camera.screenToWorld({ x: camera.width, y: camera.height });
    for (const [step, cls] of [
      [minor, "arena-grid"],
      [major, "arena-grid major"],
    ] as const) {
      const s = this.theme.resolve(cls);
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) g.moveTo(x, br.y).lineTo(x, tl.y);
      for (let y = Math.floor(br.y / step) * step; y <= tl.y; y += step) g.moveTo(tl.x, y).lineTo(br.x, y);
      g.stroke({ width: s.strokeWidth / z, color: s.stroke, alpha: s.strokeAlpha });
    }
    if (world.arena) {
      const hw = world.arena.width / 2;
      const hh = world.arena.height / 2;
      g.rect(-hw, -hh, hw * 2, hh * 2);
      strokeStyled(g, this.theme.resolve("arena-edge"), z);
    }
    for (const w of world.gravityWells) {
      g.circle(w.position.x, w.position.y, w.coreRadius);
      const s = this.theme.resolve("gravity-well");
      g.fill({ color: s.fill, alpha: s.fillAlpha });
      strokeStyled(g, s, z);
    }
  }

  private drawAsteroids(world: World, camera: Camera, alpha: number): void {
    const zoomKey = Math.round(Math.log2(camera.zoom) * 2);
    for (const a of world.asteroids) {
      let v = this.asteroidViews.get(a.id);
      if (!v) {
        v = { g: new Graphics(), zoomKey: NaN, themeVersion: -1 };
        this.asteroidViews.set(a.id, v);
        this.staticG.addChild(v.g);
      }
      if (v.zoomKey !== zoomKey || v.themeVersion !== this.theme.version) {
        v.g.clear();
        polyStyled(v.g, a.outline, this.theme.resolve("asteroid"), Math.pow(2, zoomKey / 2));
        v.zoomKey = zoomKey;
        v.themeVersion = this.theme.version;
      }
      const p = this.pose(a.id, world, alpha);
      v.g.position.set(p.x, p.y);
      v.g.rotation = p.angle;
    }
  }

  /** Jettisoned parts: drawn like their part class, dimmed by the theme's `debris` style. */
  private drawDebris(world: World, camera: Camera, alpha: number): void {
    const zoomKey = Math.round(Math.log2(camera.zoom) * 2);
    const live = new Set(world.debris.map((d) => d.id));
    for (const [id, v] of this.debrisViews) {
      if (live.has(id)) continue;
      v.g.destroy();
      this.debrisViews.delete(id);
    }
    for (const d of world.debris) {
      let v = this.debrisViews.get(d.id);
      if (!v) {
        v = { g: new Graphics(), zoomKey: NaN, themeVersion: -1 };
        this.debrisViews.set(d.id, v);
        this.staticG.addChild(v.g);
      }
      if (v.zoomKey !== zoomKey || v.themeVersion !== this.theme.version) {
        v.g.clear();
        for (const pc of d.pieces) {
          const cls = `debris cat-${pc.category}${pc.wreck ? " state-wreck" : ""}`;
          polyStyled(v.g, pc.outline, this.theme.resolve(cls), Math.pow(2, zoomKey / 2));
        }
        v.zoomKey = zoomKey;
        v.themeVersion = this.theme.version;
      }
      const p = this.pose(d.id, world, alpha);
      v.g.position.set(p.x, p.y);
      v.g.rotation = p.angle;
    }
  }

  private shipView(ship: Ship): ShipView {
    let v = this.ships.get(ship.id);
    if (!v) {
      const root = new Container();
      const hull = new Graphics();
      const fx = new Graphics();
      const overlay = new Graphics();
      root.addChild(fx, hull, overlay);
      this.worldLayer.addChild(root);
      let radius = 0;
      for (const p of ship.parts)
        for (const pt of p.def.outline)
          radius = Math.max(radius, length(add(p.position, rotate(pt, p.angle))));
      v = { root, hull, fx, overlay, radius, themeVersion: -1, stateKey: "" };
      this.ships.set(ship.id, v);
    }
    return v;
  }

  private drawShip(ship: Ship, world: World, camera: Camera, alpha: number): void {
    const v = this.shipView(ship);
    const z = camera.zoom;
    const pose = this.pose(ship.id, world, alpha);
    v.root.position.set(pose.x, pose.y);
    v.root.rotation = pose.angle;

    // Too small on screen: draw a class icon instead (spec §10.1).
    const icon = this.theme.resolve(`icon-ship team-${ship.team}`);
    if (v.radius * z < icon.minSize) {
      v.root.visible = false;
      const c = camera.worldToScreen(this.shipCenter(ship, world, alpha));
      this.screenG.circle(c.x, c.y, icon.minSize);
      strokeStyled(this.screenG, icon, 1);
      return;
    }
    v.root.visible = true;

    const zoomKey = Math.round(Math.log2(z) * 2);
    const dead = ship.defeated || ship.inert;
    const stateKey = `${zoomKey}|${dead}|${ship.parts.map((p) => (p.hp <= 0 ? "w" : p.hp < p.def.def.hp ? "d" : "o")).join("")}`;
    if (v.themeVersion !== this.theme.version || v.stateKey !== stateKey) {
      v.hull.clear();
      const zq = Math.pow(2, zoomKey / 2);
      for (const p of ship.parts) {
        const state = p.hp <= 0 ? "wreck" : p.hp < p.def.def.hp || dead ? "damaged" : "ok";
        const s = this.theme.resolve(`part cat-${p.def.def.category} team-${ship.team} state-${state}`);
        polyStyled(
          v.hull,
          p.def.outline.map((pt) => add(p.position, rotate(pt, p.angle))),
          s,
          zq,
        );
      }
      v.themeVersion = this.theme.version;
      v.stateKey = stateKey;
    }

    this.drawThrust(ship, v.fx, z);
    this.drawRadiators(ship, v.fx, z);
    this.drawTurrets(ship, v.fx, z);
    v.overlay.clear();
    if (this.eject?.shipId === ship.id) this.drawEjectMarks(ship, v.overlay, z);
    if (this.showOverlays) this.drawOverlays(ship, v.overlay, z);
    if (this.showNetworks) this.drawNetworks(ship, v.overlay, z);
  }

  private drawThrust(ship: Ship, g: Graphics, z: number): void {
    g.clear();
    const throttle = new Map<string, number>();
    ship.propulsion.actuators.forEach((a, i) => {
      if (a.kind === "gyro") return;
      throttle.set(a.partUid, Math.max(throttle.get(a.partUid) ?? 0, ship.throttles[i] ?? 0));
    });
    const eng = this.theme.resolve("fx-thrust kind-engine");
    const rcs = this.theme.resolve("fx-thrust kind-thruster");
    for (const p of ship.parts) {
      const t = throttle.get(p.uid) ?? 0;
      if (t < 0.02) continue;
      const def = p.def;
      if (def.def.engine) {
        const nozzle = def.edges[def.def.engine.nozzleEdge]!;
        const mid = add(p.position, rotate(nozzle.mid, p.angle));
        const status = ship.propulsion.engines.find((e) => e.partUid === p.uid);
        const dir = status ? scale(status.direction, -1) : toShipDir(p, nozzle.normal);
        const width = length(rotate({ x: nozzle.b.x - nozzle.a.x, y: nozzle.b.y - nozzle.a.y }, 0));
        const len = width * (1.5 + 2.5 * t) * eng.scale;
        g.moveTo(mid.x, mid.y).lineTo(mid.x + dir.x * len, mid.y + dir.y * len);
        strokeStyled(
          g,
          { ...eng, strokeWidth: eng.strokeWidth * 2, glowWidth: eng.glowWidth * (0.6 + t) },
          z,
        );
      } else if (def.def.thruster && def.thrusterDir) {
        const dir = scale(toShipDir(p, def.thrusterDir), -1);
        const c = partCentroid(p);
        const len = 1.5 * t * rcs.scale;
        g.moveTo(c.x, c.y).lineTo(c.x + dir.x * len, c.y + dir.y * len);
        strokeStyled(g, rcs, z);
      }
    }
  }

  /**
   * Radiators glow with the ship's heat (spec §7.4): brighter as the heat pool fills, dimmer when
   * retracted, covered or damaged. Colour and peak alpha come from the theme's `fx-radiator-glow`.
   */
  private drawRadiators(ship: Ship, g: Graphics, z: number): void {
    const s = this.theme.resolve("fx-radiator-glow");
    const heat = Math.min(1, ship.heatLevel / RADIATOR_GLOW_FULL);
    for (const p of ship.parts) {
      const r = p.def.def.radiator;
      if (!r || p.hp <= 0) continue;
      const work =
        (ship.radiatorExposure.get(p.uid) ?? 0) *
        (ship.radiatorsExtended ? 1 : r.retractedFactor) *
        (p.hp / p.def.def.hp);
      const k = heat * work;
      if (k < 0.02) continue;
      polyStyled(
        g,
        p.def.outline.map((pt) => add(p.position, rotate(pt, p.angle))),
        { ...s, fillAlpha: s.fillAlpha * k, strokeAlpha: s.strokeAlpha * k, glowAlpha: s.glowAlpha * k },
        z,
      );
    }
  }

  /**
   * Eject mode: wrecks and damaged parts are marked; the part under the cursor and everything that would
   * leave with it are highlighted.
   */
  private drawEjectMarks(ship: Ship, g: Graphics, z: number): void {
    const cand = this.theme.resolve("eject-candidate");
    const hover = this.theme.resolve("eject-hover");
    const hot = ship.heatLevel > 1;
    const hoverUid = this.eject?.hoverUid;
    const leaving = new Set(hoverUid ? ship.ejectionSet(hoverUid) : []);
    for (const p of ship.parts) {
      if (p.def.def.command) continue;
      const isHover = leaving.has(p.uid);
      const producesHeat = !!(
        p.def.def.reactor ||
        p.def.def.engine ||
        p.def.def.thruster ||
        p.def.def.gyro ||
        p.def.def.weapon
      );
      if (!isHover && p.hp >= p.def.def.hp && !(hot && producesHeat)) continue;
      polyStyled(
        g,
        p.def.outline.map((pt) => add(p.position, rotate(pt, p.angle))),
        isHover ? hover : cand,
        z,
      );
    }
  }

  private drawNetworks(ship: Ship, g: Graphics, z: number): void {
    const order = ship.networks.members
      .map((_, i) => i)
      .sort((a, b) => (a === ship.commandNetwork ? -1 : b === ship.commandNetwork ? 1 : a - b));
    order.forEach((net, rank) => {
      const s = this.theme.resolve(`overlay-net-${Math.min(rank, 5)}`);
      for (const uid of ship.networks.members[net]!) {
        const p = ship.part(uid);
        g.poly(
          p.def.outline.flatMap((pt) => {
            const q = add(p.position, rotate(pt, p.angle));
            return [q.x, q.y];
          }),
          true,
        );
      }
      strokeStyled(g, s, z);
    });
  }

  private drawTurrets(ship: Ship, g: Graphics, z: number): void {
    const ok = this.theme.resolve("overlay-turret");
    const blocked = this.theme.resolve("overlay-turret blocked");
    for (const w of ship.weapons) {
      if (w.def.mount !== "turret" || w.part.hp <= 0) continue;
      const p = w.part;
      const m = add(p.position, rotate({ x: w.def.muzzle[0], y: w.def.muzzle[1] }, p.angle));
      const a = p.angle + w.turret;
      const len = 1.3;
      g.moveTo(m.x, m.y).lineTo(m.x + Math.cos(a) * len, m.y + Math.sin(a) * len);
      strokeStyled(g, w.isBlocked ? blocked : ok, z);
    }
  }

  private drawOverlays(ship: Ship, g: Graphics, z: number): void {
    const com = this.theme.resolve("overlay-com");
    const c = ship.massProps.center;
    const r = com.minSize / z;
    g.circle(c.x, c.y, r)
      .moveTo(c.x - r * 1.6, c.y)
      .lineTo(c.x + r * 1.6, c.y)
      .moveTo(c.x, c.y - r * 1.6)
      .lineTo(c.x, c.y + r * 1.6);
    strokeStyled(g, com, z);
    // Achieved thrust vector, scaled to ship size at full capacity.
    const w = ship.lastWrench;
    const mag = Math.hypot(w.fx, w.fy);
    if (mag > 1) {
      const s = this.theme.resolve("overlay-thrust");
      const len = Math.min(8, (mag / ship.massProps.mass) * 0.15) * s.scale;
      g.moveTo(c.x, c.y).lineTo(c.x + (w.fx / mag) * len, c.y + (w.fy / mag) * len);
      strokeStyled(g, s, z);
    }
    const bad = this.theme.resolve("overlay-gimbal-bad");
    for (const e of ship.propulsion.engines) {
      if (!e.outOfGimbal) continue;
      const p = ship.parts.find((x) => x.uid === e.partUid);
      if (!p) continue;
      const pc = partCentroid(p);
      g.circle(pc.x, pc.y, 0.9);
      strokeStyled(g, bad, z);
    }
  }
}
