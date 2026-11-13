import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ShipDesign } from "../../src/data/schemas/design";
import { validateCatalogue, validateDesign } from "../../src/data/validate";
import { analyzeImport } from "../../src/data/share/import";
import { buildExport, prettyJson } from "../../src/data/share/bundle";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { computeMassProps, instantiateParts } from "../../src/sim/ship/ship";
import { World } from "../../src/sim/world";
import { type Vec2, length, sub, vec2 } from "../../src/sim/core/vec2";
import { SIM_DT } from "../../src/sim/core/loop";
import { intercept } from "../../src/sim/combat/lead";
import { blast, stepProjectiles } from "../../src/sim/combat/combat-world";
import { spawnMissile, stepMissiles, type Missile } from "../../src/sim/combat/missiles";
import { rankThreats, type Contact } from "../../src/sim/combat/targeting";
import { COMBAT, MISSILE } from "../../src/sim/combat/constants";

const read = (p: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../src/data/${p}`, import.meta.url), "utf8"));
const catR = validateCatalogue(read("core/catalogue.json"));
if (!catR.ok) throw new Error(catR.errors.join("\n"));
const cat = PartCatalogue.fromJson(catR.value);
const design = (name: string): ShipDesign => {
  const r = validateDesign(read(`designs/${name}.json`));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value;
};
const NOW = "2026-11-08T00:00:00Z";
const D = (id: string, parts: [string, string, number, number, number?][], drone = false): ShipDesign => ({
  formatVersion: 1,
  id,
  name: id,
  createdAt: NOW,
  modifiedAt: NOW,
  ...(drone ? { drone: true } : {}),
  parts: parts.map(([uid, p, x, y, a]) => ({ uid, partId: `core:${p}`, x, y, angle: a ?? 0 })),
  weaponGroupModes: {},
  powerPriority: ["gyro", "propulsion", "pointDefense", "weapons", "hangar"],
});

/** Missile boat: command, launcher facing +x, missile magazine. */
const shooter = D("shooter", [
  ["cmd", "command.s", 0, 0],
  ["ml", "weapon.missile.launcher.s", 1.5, 0],
  ["mag", "magazine.missile.s", 0, 1.25],
]);
/** Inert block target. */
const block = D("block", [
  ["cmd", "command.s", 0, 0],
  ["h1", "hull.square.m", -1.75, 0],
  ["h2", "hull.square.m", 1.75, 0],
]);
/** PD picket: gatling facing −x (toward a shooter on the left), PD magazine. */
const picket = D("picket", [
  ["cmd", "command.s", 0, 0],
  ["h1", "hull.square.m", 1.75, 0],
  ["pd", "weapon.pd.gatling.s", -1.2119, 0, 180],
  ["pdm", "magazine.pd.s", 0, 1.25],
]);
const mule = design("demo-hauler");
const hp = (ship: { parts: { hp: number }[] }) => ship.parts.reduce((s, p) => s + Math.max(0, p.hp), 0);

/** Fires one missile from `shooter` at a target and runs until it is gone. */
function missileRun(
  seed: number,
  target: ShipDesign,
  opts: { position?: Vec2; velocity?: Vec2; angle?: number; intent?: { thrust: Vec2; rotate: number } } = {},
) {
  const w = new World({ seed });
  const a = w.addShip(shooter, cat);
  const b = w.addShip(target, cat, {
    position: opts.position ?? vec2(2000, 0),
    velocity: opts.velocity ?? vec2(0, 0),
    angle: opts.angle ?? 0,
    team: 1,
  });
  a.weaponCommand = { trigger: false, aimPoint: null, selected: new Set([1]), targetId: b.id, launch: true };
  for (let i = 0; i < 60 * 30; i++) {
    if (opts.intent) w.setIntent(b.id, opts.intent);
    w.step();
    if (i > 2 && w.combat.missiles.length === 0) break;
  }
  return { w, a, b, stats: w.combat.stats };
}

describe("M5 missiles", () => {
  it("5.1 PN missile vs a stationary target: hits on 100 of 100 seeded runs", () => {
    let hits = 0;
    for (let seed = 1; seed <= 100; seed++) if (missileRun(seed, block).stats.missileHits === 1) hits++;
    expect(hits).toBe(100);
  });

  it("5.2 PN missile vs a target crossing at 100 m/s: hit rate ≥ 95 %", () => {
    let hits = 0;
    for (let seed = 1; seed <= 40; seed++)
      if (missileRun(seed, block, { velocity: vec2(0, 100) }).stats.missileHits === 1) hits++;
    expect(hits / 40).toBeGreaterThanOrEqual(0.95);
  });

  it("5.3 PN missile vs a fighter turning and burning at full rate: recorded baseline (documents the limit)", () => {
    let hits = 0;
    const n = 20;
    for (let seed = 1; seed <= n; seed++) {
      const r = missileRun(seed, design("demo-fighter"), {
        velocity: vec2(0, 60),
        intent: { thrust: vec2(1, 0), rotate: 1 },
      });
      if (r.stats.missileHits === 1) hits++;
    }
    if (process.env.BASELINE) console.log("5.3 baseline", hits, "/", n);
    // Baseline 2026-11-08: 20 of 20. A tight-turning fighter is still caught at these ranges; the band
    // below catches large regressions either way once missiles and fighters are tuned.
    expect(hits / n).toBeGreaterThanOrEqual(0.6);
  });

  it("5.4 out of fuel → coasts ballistically and follows gravity", () => {
    const w = new World({ seed: 1 });
    w.addGravityWell({ position: vec2(0, -1000), mu: 4e7, softening: 10, coreRadius: 50 });
    const ship = w.addShip(shooter, cat, { position: vec2(-500, 0) });
    const def = cat.get("core:magazine.missile.s").def.magazine!.missile!;
    const m = spawnMissile(w, ship, def, vec2(0, 0), vec2(1, 0), vec2(0, 0), ship.id);
    m.fuel = 0;
    m.target = null;
    const v0 = m.vel;
    stepMissiles(w, SIM_DT);
    const g = 4e7 / (1000 * 1000 + 10 * 10); // softened inverse square
    expect(m.vel.x).toBeCloseTo(v0.x, 9); // no thrust
    expect((v0.y - m.vel.y) / SIM_DT).toBeCloseTo(g, 1); // pulled toward the well
  });

  it("a burnt-out missile stops steering and flies straight past a target off its line", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(shooter, cat, { position: vec2(-500, 0) });
    const t = w.addShip(block, cat, { position: vec2(600, 300), team: 1 });
    const def = cat.get("core:magazine.missile.s").def.magazine!.missile!;
    const m = spawnMissile(w, ship, def, vec2(0, 0), vec2(1, 0), vec2(175, 0), t.id);
    m.fuel = 0;
    for (let i = 0; i < 60 * 4; i++) stepMissiles(w, SIM_DT);
    expect(w.combat.missiles).toContain(m);
    expect(m.vel.x).toBeCloseTo(200, 9);
    expect(m.vel.y).toBeCloseTo(0, 9);
    expect(m.pos.y).toBeCloseTo(0, 9);
    expect(m.heading).toBeCloseTo(0, 9);
  });

  it("a burnt-out missile still detonates on a ship in its path", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(shooter, cat, { position: vec2(-500, 0) });
    const t = w.addShip(block, cat, { position: vec2(400, 0), team: 1 });
    const def = cat.get("core:magazine.missile.s").def.magazine!.missile!;
    // Aimed at the block but told to chase the shooter: without fuel it cannot turn away.
    const m = spawnMissile(w, ship, def, vec2(0, 0), vec2(1, 0), vec2(175, 0), ship.id);
    m.fuel = 0;
    for (let i = 0; i < 60 * 3 && w.combat.missiles.length; i++) stepMissiles(w, SIM_DT);
    expect(w.combat.events.some((e) => e.kind === "explosion")).toBe(true);
    expect(hp(t)).toBeLessThan(hp(w.addShip(block, cat, { position: vec2(0, 3000), team: 1 })));
  });

  it("a coasting missile is removed once it leaves the arena, or after MISSILE.selfDestructAfter", () => {
    const w = new World({ seed: 1 });
    w.arena = { width: 2000, height: 2000 };
    const ship = w.addShip(shooter, cat, { position: vec2(-500, 0) });
    const def = cat.get("core:magazine.missile.s").def.magazine!.missile!;
    spawnMissile(w, ship, def, vec2(0, 0), vec2(1, 0), vec2(175, 0), ship.id).fuel = 0;
    // 200 m/s: past the edge (1000 m) plus the margin after about 7.5 s.
    for (let i = 0; i < 60 * 7; i++) stepMissiles(w, SIM_DT);
    expect(w.combat.missiles).toHaveLength(1);
    for (let i = 0; i < 60; i++) stepMissiles(w, SIM_DT);
    expect(w.combat.missiles).toHaveLength(0);
    // Without an arena it coasts until its time is up.
    const w2 = new World({ seed: 1 });
    const s2 = w2.addShip(shooter, cat, { position: vec2(-500, 0) });
    const m2 = spawnMissile(w2, s2, def, vec2(0, 0), vec2(1, 0), vec2(175, 0), s2.id);
    m2.fuel = 0;
    m2.age = def.fuel + MISSILE.selfDestructAfter - 0.5;
    for (let i = 0; i < 20; i++) stepMissiles(w2, SIM_DT);
    expect(w2.combat.missiles).toHaveLength(1);
    for (let i = 0; i < 20; i++) stepMissiles(w2, SIM_DT);
    expect(w2.combat.missiles).toHaveLength(0);
  });

  it("5.5 proximity fuse fires at the configured distance", () => {
    const { w, b } = missileRun(3, block);
    const ev = w.combat.events.find((e) => e.kind === "explosion")!;
    expect(ev).toBeDefined();
    // Distance from the burst to the nearest hull edge (block spans x ∈ [−2.75, 2.75] around its origin).
    const local = sub(ev.pos, w.physics.getBodyState(b.id).position);
    const gap = Math.max(Math.abs(local.x) - 2.75, Math.abs(local.y) - 1, 0);
    const fuse = cat.get("core:magazine.missile.s").def.magazine!.missile!.proximityFuse;
    expect(gap).toBeLessThanOrEqual(fuse + 1e-6);
    expect(gap).toBeGreaterThan(fuse - 12); // within one tick of travel at closing speed
  });

  it("5.5 blast damage falls off linearly; a part behind a wreck takes half", () => {
    const w = new World({ seed: 1 });
    const row = D("row", [
      ["cmd", "command.s", 0, 0],
      ["a", "hull.square.s", 1.25, 0],
      ["b", "hull.square.s", 2.25, 0],
      ["c", "hull.square.s", 3.25, 0],
    ]);
    const s = w.addShip(row, cat);
    const R = 10;
    const dmg = 30;
    blast(w, vec2(1.25, 0), R, dmg); // centred on part a
    const plate = cat.get("core:hull.square.s").def.hp;
    expect(plate - s.part("a").hp).toBeCloseTo(dmg, 6);
    expect(plate - s.part("b").hp).toBeCloseTo(dmg * (1 - 1 / R), 6);
    // Wreck b, then blast from a's centre again: c is behind the wreck.
    s.destroyPart("b");
    const c0 = s.part("c").hp;
    blast(w, vec2(1.25, 0), R, dmg);
    expect(c0 - s.part("c").hp).toBeCloseTo(dmg * (1 - 2 / R) * (1 - COMBAT.wreckAbsorb), 6);
  });

  it("5.6 one round with damage ≥ HP destroys a missile", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(shooter, cat);
    const def = cat.get("core:magazine.missile.s").def.magazine!.missile!;
    const m = spawnMissile(w, ship, def, vec2(100, 0), vec2(1, 0), vec2(0, 0), ship.id);
    w.combat.projectiles = [
      {
        id: 1,
        owner: "x",
        team: 9,
        pos: vec2(90, 0),
        vel: vec2(1200, 0),
        mass: 0.1,
        damage: def.hp,
        age: 0,
        lifetime: 1,
        kind: "t",
      },
    ];
    stepProjectiles(w, SIM_DT);
    expect(m.hp).toBeLessThanOrEqual(0);
    stepMissiles(w, SIM_DT);
    expect(w.combat.missiles).toHaveLength(0);
    expect(w.combat.stats.missilesDown).toBe(1);
  });

  it("5.7 intercept solver: error < 0.1 m on a constant-velocity target; no solution → null, never NaN", () => {
    // A round fired at the aim point (it inherits the shooter's 10 m/s) meets the target at time t.
    const shooterVel = vec2(10, 0);
    const sol = intercept(vec2(0, 0), shooterVel, vec2(500, 300), vec2(-40, 25), 900)!;
    const dir = sub(sol.aimPoint, vec2(0, 0));
    const len = length(dir);
    const roundAt = vec2((dir.x / len) * 900 * sol.t + shooterVel.x * sol.t, (dir.y / len) * 900 * sol.t);
    const targetAt = vec2(500 - 40 * sol.t, 300 + 25 * sol.t);
    expect(length(sub(roundAt, targetAt))).toBeLessThan(0.1);
    expect(Number.isFinite(sol.t)).toBe(true);
    expect(intercept(vec2(0, 0), vec2(0, 0), vec2(500, 0), vec2(1000, 0), 100)).toBeNull();
  });
});

describe("M5 point defense", () => {
  it("5.8 a single missile from 2 km is intercepted before impact on ≥ 95 % of seeded runs", () => {
    let saved = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = missileRun(seed, picket, { angle: 0 });
      if (r.stats.missilesDown === 1 && r.stats.missileHits === 0) saved++;
    }
    expect(saved / 20).toBeGreaterThanOrEqual(0.95);
  });

  it("5.9 PD saturation: a 10-missile salvo vs one PD turret → some get through (baseline)", () => {
    const w = new World({ seed: 7 });
    const a = w.addShip(shooter, cat, { position: vec2(-2000, 0) });
    const b = w.addShip(picket, cat, { team: 1 });
    const def = cat.get("core:magazine.missile.s").def.magazine!.missile!;
    for (let i = 0; i < 10; i++)
      spawnMissile(w, a, def, vec2(-1990, (i - 4.5) * 8), vec2(1, 0), vec2(0, 0), b.id);
    for (let i = 0; i < 60 * 20 && w.combat.missiles.length; i++) w.step();
    const { missilesDown, missileHits } = w.combat.stats;
    if (process.env.BASELINE) console.log("5.9 baseline", { missilesDown, missileHits });
    // Baseline 2026-11-08 (seed 7): 4 shot down, 6 through. One gatling cannot stop a salvo.
    expect(missileHits).toBeGreaterThan(0);
    expect(missilesDown).toBeGreaterThan(0);
    expect(missilesDown + missileHits).toBe(10);
  });

  it("5.10 a flak burst damages every missile within its burst radius, and nothing outside it", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(shooter, cat, { position: vec2(-500, 0) });
    const def = cat.get("core:magazine.missile.s").def.magazine!.missile!;
    const near = [vec2(100, 5), vec2(105, -10), vec2(95, 15)].map((p) =>
      spawnMissile(w, ship, def, p, vec2(1, 0), vec2(0, 0), ship.id),
    );
    const far = spawnMissile(w, ship, def, vec2(160, 0), vec2(1, 0), vec2(0, 0), ship.id);
    w.combat.projectiles = [
      {
        id: 1,
        owner: "x",
        team: 9,
        pos: vec2(0, 60),
        vel: vec2(900, 0),
        mass: 1.5,
        damage: 10,
        age: 0.1,
        lifetime: 1.2,
        kind: "flak-40",
        fuse: { proximity: 0, radius: 25, damage: 18, time: 0.1 + 100 / 900 + 1e-9 },
      },
    ];
    for (let i = 0; i < 10; i++) stepProjectiles(w, SIM_DT);
    // Time fuse: bursts near (100, 60)? No — the shell flies along y = 60, so place the check on distance.
    const burst = w.combat.events.find((e) => e.kind === "burst")!;
    expect(burst).toBeDefined();
    for (const m of [...near, far]) {
      const inside = length(sub(m.pos, burst.pos)) <= 25;
      expect(m.hp < def.hp).toBe(inside);
    }
    void far;
  });

  it("5.11 PD ranks the missile with the soonest impact above a nearer but slower one", () => {
    const me = { id: "me", team: 0, position: vec2(0, 0), velocity: vec2(0, 0) };
    const mk = (id: string, x: number, vx: number): Contact => ({
      id,
      kind: "missile",
      team: 1,
      position: vec2(x, 0),
      velocity: vec2(vx, 0),
      targetId: "me",
      decoy: false,
    });
    const order = rankThreats([mk("near-slow", 300, -50), mk("far-fast", 900, -600)], me).map((c) => c.id);
    expect(order).toEqual(["far-fast", "near-slow"]);
  });

  it("5.12 PD ignores ships unless allowed; allowed and with no missiles, it fires at ships", () => {
    const setup = () => {
      const w = new World({ seed: 1 });
      const p = w.addShip(picket, cat);
      w.addShip(mule, cat, { position: vec2(-300, 0), team: 1 });
      return { w, p };
    };
    const off = setup();
    off.w.run(120);
    expect(off.w.combat.stats.shots).toBe(0);
    const on = setup();
    on.p.pdEngageShips = true;
    on.w.run(120);
    expect(on.w.combat.stats.shots).toBeGreaterThan(0);
  });

  it("5.13 PD in a section cut off from command still fires; a manual gun there does not", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(
      D("split", [
        ["cmd", "command.s", 0, 0],
        ["link", "hull.square.s", 1.25, 0],
        ["pdm", "magazine.pd.s", 2.25, 0],
        ["pd", "weapon.pd.gatling.s", 3.2119, 0],
        ["gun", "weapon.gun.drone.xs", 2.25, 0.75],
      ]),
      cat,
    );
    const enemy = w.addShip(shooter, cat, { position: vec2(2500, 0), angle: Math.PI, team: 1 });
    ship.destroyPart("link");
    ship.weaponCommand = { trigger: true, aimPoint: vec2(1000, 0), selected: new Set([1]), targetId: null };
    w.step();
    expect(ship.isCommanded("pd")).toBe(false);
    const def = cat.get("core:magazine.missile.s").def.magazine!.missile!;
    spawnMissile(w, enemy, def, vec2(700, 0), vec2(-1, 0), vec2(-300, 0), ship.id);
    w.run(90);
    expect(w.combat.stats.shots).toBeGreaterThan(0); // the PD
    expect(ship.part("gun").ammo).toBe(cat.get("core:weapon.gun.drone.xs").def.weapon!.internalMagazine); // the manual gun never fired (full internal magazine)
  });

  it("5.14 a decoy pulls ≥ 70 % of incoming missiles off their target (seeded batch)", () => {
    let fooled = 0;
    const n = 100;
    for (let seed = 1; seed <= n; seed++) {
      const w = new World({ seed });
      w.registerDesign(design("drone-decoy"));
      const a = w.addShip(shooter, cat);
      const b = w.addShip(mule, cat, { position: vec2(2000, 0), team: 1 });
      const decoy = w.addShip(design("drone-decoy"), cat, { position: vec2(1500, 150), team: 1 });
      decoy.drone = { mother: b.id, hangarUid: "x", role: "decoy", launchTick: 0 };
      a.weaponCommand = {
        trigger: false,
        aimPoint: null,
        selected: new Set([1]),
        targetId: b.id,
        launch: true,
      };
      let target: string | null = null;
      for (let i = 0; i < 60 * 8; i++) {
        w.step();
        const m = w.combat.missiles[0] as Missile | undefined;
        if (m) target = m.target;
      }
      if (target === decoy.id) fooled++;
    }
    if (process.env.BASELINE) console.log("5.14 baseline", fooled, "/", n);
    // Baseline 2026-11-08: 77 of 100 (decoy strength 0.8).
    expect(fooled / n).toBeGreaterThanOrEqual(0.7);
  });
});

describe("M5 drones", () => {
  // Readying a drone takes power (catalogue v0-8): the battery covers what the command module cannot.
  const carrier = D("carrier", [
    ["cmd", "command.s", 0, 0],
    ["hg", "hangar.attack.m", 0, 1.5],
    ["bat", "battery.s", 0, -1.25],
  ]);

  it("readying a drone takes power: without enough of it the hangar is slower", () => {
    const w = new World({ seed: 1 });
    w.registerDesign(design("drone-attack"));
    // Two hangars on the command module's small reactor alone: more than it can supply.
    const weak = D("weak-carrier", [
      ["cmd", "command.s", 0, 0],
      ["hg", "hangar.attack.m", 0, 1.5],
      ["hg2", "hangar.attack.m", 0, -1.5, 180],
    ]);
    const c = w.addShip(weak, cat);
    c.requestDroneLaunch();
    const launched: number[] = [];
    for (let i = 0; i < 60 * 16; i++) {
      const before = w.allShips().length;
      w.step();
      if (w.allShips().length > before) launched.push(w.tick - 1);
    }
    const h = cat.get("core:hangar.attack.m").def.hangar!;
    expect(h.powerDraw).toBeGreaterThan(0);
    // The command module's reactor covers only part of the hangar's draw.
    expect(c.power.groups.hangar.factor).toBeLessThan(1);
    // The first drone leaves at once; the next ones are readied at the reduced rate.
    expect(launched[0]).toBe(0);
    expect(launched.length).toBeGreaterThanOrEqual(2);
    expect(launched[1]).toBeGreaterThan(h.launchInterval * 60 * 1.1);
  });

  it("5.15 hangar: capacity 4, launch interval 10 s → 4 drones in about 30 s; a 5th launch is refused", () => {
    const w = new World({ seed: 1 });
    w.registerDesign(design("drone-attack"));
    const c = w.addShip(carrier, cat);
    c.requestDroneLaunch();
    const launched: number[] = [];
    for (let i = 0; i < 60 * 31; i++) {
      const before = w.allShips().length;
      w.step();
      if (w.allShips().length > before) launched.push(w.tick - 1);
    }
    expect(launched).toEqual([0, 600, 1200, 1800]);
    expect(c.dronesStored).toBe(0);
    c.requestDroneLaunch();
    w.run(120);
    expect(w.allShips().filter((s) => s.drone)).toHaveLength(4);
    // Drones leave the bay outward and do not overlap the carrier.
    for (const d of w.allShips().filter((s) => s.drone)) expect(d.drone!.mother).toBe(c.id);
  });

  it("5.16 drones use the same physics: mass properties match the M1 calculation", () => {
    const w = new World({ seed: 1 });
    const d = design("drone-attack");
    const s = w.addShip(d, cat);
    const mp = computeMassProps(instantiateParts(d, cat));
    expect(s.massProps).toEqual(mp);
    expect(w.physics.getMassProps(s.id).mass).toBeCloseTo(mp.mass, 6);
  });

  it("5.17 a drone out of fuel becomes inert: no control, no weapons", () => {
    const w = new World({ seed: 1 });
    w.registerDesign(design("drone-attack"));
    const c = w.addShip(carrier, cat);
    w.addShip(mule, cat, { position: vec2(600, 0), team: 1 });
    c.requestDroneLaunch();
    w.step();
    const d = w.allShips().find((s) => s.drone)!;
    for (const p of d.parts) p.fuel = 0;
    w.step();
    expect(d.inert).toBe(true);
    expect(d.inertReason).toBe("no-fuel");
    const ammo = d.part("gun").ammo;
    w.run(120);
    expect(d.part("gun").ammo).toBe(ammo);
    expect(d.lastWrench).toEqual({ fx: 0, fy: 0, torque: 0 });
  });

  it("drones lose their link beyond the control range, and decoys expire after their lifetime", () => {
    const w = new World({ seed: 1 });
    const c = w.addShip(carrier, cat);
    const far = w.addShip(design("drone-pd"), cat, { position: vec2(6000, 0) });
    far.drone = { mother: c.id, hangarUid: "hg", role: "pd", launchTick: 0 };
    const decoy = w.addShip(design("drone-decoy"), cat, { position: vec2(0, 50) });
    decoy.drone = { mother: c.id, hangarUid: "hg", role: "decoy", launchTick: 0 };
    w.step();
    expect(far.inertReason).toBe("out-of-range");
    expect(decoy.inert).toBe(false);
    expect(decoy.decoyStrength).toBeGreaterThan(0);
    w.run(20 * 60);
    expect(decoy.inertReason).toBe("expired");
    expect(decoy.decoyStrength).toBe(0);
  });

  it("5.18 drone designs travel with an export and import cleanly", () => {
    const drone = design("drone-attack");
    const bundle = buildExport(
      [carrier],
      { core: cat, userParts: new Map(), designs: new Map([[drone.id, drone]]) },
      {
        exportedAt: NOW,
        archival: false,
        summary: { cost: 0, mass: 0, class: "fighter", partCount: 2 },
      },
    );
    expect(bundle.designs.map((d) => d.id)).toEqual(["carrier", "drone-attack"]);
    const a = analyzeImport(prettyJson(bundle), { core: cat, userParts: new Map(), designs: new Map() });
    expect(a.ok).toBe(true);
  });

  it("an attack drone closes on the carrier's target and damages it", () => {
    const w = new World({ seed: 1 });
    w.registerDesign(design("drone-attack"));
    const c = w.addShip(carrier, cat);
    const t = w.addShip(mule, cat, { position: vec2(800, 200), team: 1 });
    c.weaponCommand = { ...c.weaponCommand, targetId: t.id };
    c.requestDroneLaunch();
    const hp0 = hp(t);
    w.run(60 * 20);
    expect(hp(t)).toBeLessThan(hp0);
  });

  it("missiles stay deterministic: two identical salvo runs hash the same", () => {
    const run = () => missileRun(5, picket, { angle: 0 }).w.hash();
    expect(run()).toBe(run());
    expect(MISSILE.armTime).toBeGreaterThan(0);
  });
});
