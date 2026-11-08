import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import type { ShipDesign } from "../../src/data/schemas/design";
import type { PartDef, WeaponDef } from "../../src/data/schemas/part";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { World, type SpawnOptions } from "../../src/sim/world";
import { angleOf, degToRad, length, vec2, type Vec2 } from "../../src/sim/core/vec2";
import { Rng } from "../../src/sim/core/rng";
import { SIM_DT } from "../../src/sim/core/loop";
import { afterArmor, beamFalloff, collisionDamage, damageAlongRay } from "../../src/sim/combat/damage";
import { intercept } from "../../src/sim/combat/lead";
import { stepProjectiles } from "../../src/sim/combat/combat-world";
import { weaponPerformance } from "../../src/sim/combat/weapons";
import { COMBAT } from "../../src/sim/combat/constants";
import { design, testCatalogue } from "../helpers";

const base = testCatalogue();
const sq = base.get("core:test.square").def;
const weapon = (
  id: string,
  w: Partial<WeaponDef> & Pick<WeaponDef, "kind" | "mount">,
  extra: Partial<PartDef> = {},
): PartDef => ({
  ...sq,
  id: `core:test.${id}`,
  name: id,
  category: "weapon",
  edges: ["snap", "function", "snap", "snap"],
  weapon: {
    muzzle: [0.5, 0],
    internalMagazine: 0,
    fireInterval: 0.1,
    range: 2000,
    spread: 0,
    ...w,
  } as WeaponDef,
  ...extra,
});
const parts: PartDef[] = [
  {
    ...sq,
    id: "core:test.plate",
    name: "thin plate",
    outline: [
      [-0.25, -2],
      [0.25, -2],
      [0.25, 2],
      [-0.25, 2],
    ],
    mass: 1e6,
    hp: 1e9,
  },
  { ...sq, id: "core:test.armor", name: "armor", category: "armor", armor: 20, hp: 400 },
  { ...sq, id: "core:test.big", name: "big target", mass: 1e5, hp: 1e9 },
  // Indestructible versions for measurements that must not end with the target defeated.
  { ...base.get("core:test.command").def, id: "core:test.tough.command", hp: 1e9 },
  { ...base.get("core:test.engine").def, id: "core:test.tough.engine", hp: 1e9 },
  { ...base.get("core:test.fueltank").def, id: "core:test.tough.tank", hp: 1e9 },
  weapon("fastgun", {
    kind: "projectile",
    mount: "fixed",
    projectile: { speed: 3000, mass: 1, damage: 50, lifetime: 2 },
  }),
  weapon("slowgun", {
    kind: "projectile",
    mount: "fixed",
    fireInterval: 0.5,
    projectile: { speed: 100, mass: 10, damage: 1, lifetime: 5 },
  }),
  weapon(
    "turret",
    {
      kind: "projectile",
      mount: "turret",
      arc: [-135, 135],
      traverseRate: 45,
      muzzle: [0, 0],
      projectile: { speed: 1000, mass: 0.1, damage: 10, lifetime: 3 },
    },
    { edges: ["snap", "snap", "snap", "snap"] },
  ),
  weapon(
    "turret.fast",
    {
      kind: "projectile",
      mount: "turret",
      arc: [-135, 135],
      traverseRate: 180,
      muzzle: [0, 0],
      projectile: { speed: 1000, mass: 0.1, damage: 10, lifetime: 3 },
    },
    { edges: ["snap", "snap", "snap", "snap"] },
  ),
  weapon("beam", {
    kind: "beam",
    mount: "fixed",
    powerDraw: 60,
    range: 100,
    beam: { dps: 100, falloffStart: 50 },
  }),
  weapon("ammogun", {
    kind: "projectile",
    mount: "fixed",
    ammoType: "test-ammo",
    internalMagazine: 10,
    fireInterval: 0.5,
    projectile: { speed: 500, mass: 0.1, damage: 1, lifetime: 1 },
  }),
];
const cat = new PartCatalogue("combat", [...base.all().map((p) => p.def), ...parts]);

let shipCounter = 0;
function addShip(
  w: World,
  list: [string, number, number, number?][],
  opts: SpawnOptions & {
    modes?: Record<string, "hold" | "manual" | "ai">;
    groups?: Record<number, number>;
  } = {},
) {
  const d: ShipDesign = {
    ...design("brick"),
    id: `ship${++shipCounter}`,
    weaponGroupModes: opts.modes ?? {},
    parts: list.map(([partId, x, y, angle], i) => ({
      uid: `p${i + 1}`,
      partId,
      x,
      y,
      angle: angle ?? 0,
      ...(opts.groups?.[i + 1] ? { weaponGroup: opts.groups[i + 1] } : {}),
    })),
  };
  return w.addShip(d, cat, opts);
}
const fire = (aim: Vec2, groups = [1], trigger = true) => ({
  trigger,
  aimPoint: aim,
  selected: new Set(groups),
  targetId: null,
});

describe("M4 projectiles", () => {
  it("4.1 projectile velocity = shooter velocity + muzzle velocity × direction", () => {
    const w = new World({ seed: 1 });
    const s = addShip(
      w,
      [
        ["core:test.command", 0, 0],
        ["core:test.slowgun", 1, 0],
      ],
      { velocity: vec2(10, 5) },
    );
    s.weaponCommand = fire(vec2(1000, 0));
    w.step();
    const pr = w.combat.projectiles[0]!;
    expect(pr.vel.x).toBeCloseTo(110, 6);
    expect(pr.vel.y).toBeCloseTo(5, 6);
  });

  it("4.2 a 3000 m/s round never tunnels through a 0.5 m plate (1000 seeded runs)", () => {
    const w = new World({ seed: 1 });
    addShip(w, [["core:test.plate", 0, 0]], { position: vec2(0, 0) });
    const rng = new Rng(42);
    let hits = 0;
    for (let i = 0; i < 1000; i++) {
      w.combat.projectiles = [
        {
          id: i,
          owner: "nobody",
          team: 9,
          pos: vec2(-rng.range(60, 200), rng.range(-1.9, 1.9)),
          vel: vec2(3000, 0),
          mass: 1,
          damage: 1,
          age: 0,
          lifetime: 1,
          kind: "t",
        },
      ];
      const before = w.combat.stats.hits;
      for (let t = 0; t < 10 && w.combat.projectiles.length; t++) stepProjectiles(w, SIM_DT);
      if (w.combat.stats.hits > before) hits++;
    }
    expect(hits).toBe(1000);
  });

  it("4.3 a round hits the first part on its path: armor in front of a reactor takes it all", () => {
    const w = new World({ seed: 1 });
    const t = addShip(
      w,
      [
        ["core:test.armor", 0, 0],
        ["core:test.reactor", 1, 0],
      ],
      { position: vec2(50, 0) },
    );
    w.combat.projectiles = [
      {
        id: 1,
        owner: "x",
        team: 9,
        pos: vec2(0, 0),
        vel: vec2(1000, 0),
        mass: 0.01,
        damage: 100,
        age: 0,
        lifetime: 1,
        kind: "t",
      },
    ];
    for (let i = 0; i < 10; i++) stepProjectiles(w, SIM_DT);
    expect(t.part("p2").hp).toBe(100); // reactor (behind, at x = 51) untouched
    expect(t.part("p1").hp).toBe(400 - 80); // armor 20 → 80 damage
  });

  it("4.21 a projectile changes the target's momentum by k·m·v_rel (±1 %), k = momentumTransfer", () => {
    const w = new World({ seed: 1 });
    const t = addShip(w, [["core:test.big", 0, 0]], { position: vec2(30, 0) });
    w.combat.projectiles = [
      {
        id: 1,
        owner: "x",
        team: 9,
        pos: vec2(0, 0),
        vel: vec2(100, 0),
        mass: 10,
        damage: 1,
        age: 0,
        lifetime: 2,
        kind: "t",
      },
    ];
    for (let i = 0; i < 60; i++) stepProjectiles(w, SIM_DT);
    const p = w.physics.getBodyState(t.id).linearVelocity.x * t.massProps.mass;
    expect(Math.abs(p / (1000 * COMBAT.momentumTransfer) - 1)).toBeLessThan(0.01);
  });
});

describe("M4 damage model", () => {
  it("4.4 armor: 50 vs 20 → 30; 10 vs 20 with minDamage 2 → 2", () => {
    expect(afterArmor(50, 20)).toBe(30);
    expect(afterArmor(10, 20, 2)).toBe(2);
    expect(afterArmor(10, 0)).toBe(10);
  });

  it("4.5 / 4.6 wrecks pass on 50 %; two wrecks pass on 25 %", () => {
    const one = damageAlongRay(
      [
        { uid: "w", intact: false, armor: 0 },
        { uid: "x", intact: true, armor: 0 },
      ],
      100,
    );
    expect(one.applied).toEqual([{ uid: "x", damage: 50 }]);
    const two = damageAlongRay(
      [
        { uid: "w1", intact: false, armor: 0 },
        { uid: "w2", intact: false, armor: 0 },
        { uid: "x", intact: true, armor: 0 },
      ],
      100,
    );
    expect(two.applied).toEqual([{ uid: "x", damage: 25 }]);
    // In the world: a wreck in front of a part.
    const w = new World({ seed: 1 });
    const t = addShip(
      w,
      [
        ["core:test.square", 0, 0],
        ["core:test.square", 1, 0],
      ],
      { position: vec2(50, 0) },
    );
    t.part("p1").hp = 0;
    w.combat.projectiles = [
      {
        id: 1,
        owner: "x",
        team: 9,
        pos: vec2(0, 0),
        vel: vec2(1000, 0),
        mass: 0.01,
        damage: 100,
        age: 0,
        lifetime: 1,
        kind: "t",
      },
    ];
    for (let i = 0; i < 10; i++) stepProjectiles(w, SIM_DT);
    expect(t.part("p2").hp).toBe(50);
  });

  it("4.16 a destroyed part becomes a wreck: networks split, mass unchanged, still collides", () => {
    const w = new World({ seed: 1 });
    const s = addShip(w, [
      ["core:test.command", 0, 0],
      ["core:test.square", 1, 0],
      ["core:test.square", 2, 0],
    ]);
    const mass = s.massProps.mass;
    s.applyDamage("p2", 1000);
    w.step();
    expect(s.part("p2").hp).toBeLessThanOrEqual(0);
    expect(s.networks.members.length).toBe(2);
    expect(s.massProps.mass).toBe(mass);
    // Still in the way of rounds (wreck absorbs half, the rest reaches p3... from the +x side p3 is first).
    expect(s.layout.raycastAll(vec2(1, -5), vec2(0, 1), 10).map((h) => h.uid)).toEqual(["p2"]);
  });

  it("4.20 collision damage: below the threshold none, above proportional to both parts", () => {
    expect(collisionDamage(COMBAT.collisionImpulseThreshold * 0.9)).toBe(0);
    expect(collisionDamage(COMBAT.collisionImpulseThreshold + 1000)).toBeCloseTo(
      1000 * COMBAT.collisionDamagePerImpulse,
      9,
    );
    const w = new World({ seed: 1 });
    const a = addShip(w, [["core:test.big", 0, 0]], { position: vec2(-3, 0), velocity: vec2(20, 0) });
    const b = addShip(w, [["core:test.big", 0, 0]], { position: vec2(3, 0), velocity: vec2(-20, 0) });
    w.run(30);
    expect(a.part("p1").hp).toBeLessThan(1e9);
    expect(b.part("p1").hp).toBeLessThan(1e9);
    expect(1e9 - a.part("p1").hp).toBeCloseTo(1e9 - b.part("p1").hp, 0);
    const slow = new World({ seed: 1 });
    const c = addShip(slow, [["core:test.square", 0, 0]], { position: vec2(-3, 0), velocity: vec2(0.5, 0) });
    addShip(slow, [["core:test.square", 0, 0]], { position: vec2(3, 0), velocity: vec2(-0.5, 0) });
    slow.run(600);
    expect(c.part("p1").hp).toBe(100);
  });

  it("destroyed fuel tanks explode and damage nearby parts of the same ship", () => {
    const w = new World({ seed: 1 });
    const s = addShip(w, [
      ["core:test.command", 0, 0],
      ["core:test.fueltank", 1, 0],
      ["core:test.square", 2, 0],
      ["core:test.square", 6, 0],
    ]);
    s.applyDamage("p2", 1000);
    w.step();
    expect(s.part("p3").hp).toBeLessThan(100); // 1 m away
    expect(s.part("p4").hp).toBe(100); // 5 m away, outside 3 m radius
    expect(w.combat.events.some((e) => e.kind === "explosion")).toBe(true);
  });
});

describe("M4 beams", () => {
  it("4.7 beam dps 100 for 1 s → 100 damage (±1 tick); falloff beyond falloffStart", () => {
    expect(beamFalloff(30, 50, 100)).toBe(1);
    expect(beamFalloff(75, 50, 100)).toBeCloseTo(0.5, 9);
    expect(beamFalloff(100, 50, 100)).toBe(0);
    const w = new World({ seed: 1 });
    const s = addShip(w, [
      ["core:test.command", 0, 0],
      ["core:test.beam", 1, 0],
      ["core:test.reactor", 0, 1],
    ]);
    const t = addShip(w, [["core:test.big", 0, 0]], { position: vec2(20, 0) });
    s.weaponCommand = fire(vec2(20, 0));
    w.step(); // first tick requests power
    const hp0 = t.part("p1").hp;
    w.run(60);
    expect(Math.abs(hp0 - t.part("p1").hp - 100)).toBeLessThanOrEqual(100 / 60 + 1e-6);
    expect(w.combat.beams).toHaveLength(1);
  });

  it("4.8 beams draw power while firing; at half power they do half damage", () => {
    const halfReactor: PartDef = {
      ...base.get("core:test.reactor").def,
      id: "core:test.reactor.half",
      reactor: { maxOutput: 30, heatPerWatt: 0 },
    };
    const c2 = new PartCatalogue("c2", [...cat.all().map((p) => p.def), halfReactor]);
    const w = new World({ seed: 1 });
    const d: ShipDesign = {
      ...design("brick"),
      id: "beamship",
      parts: [
        { uid: "p1", partId: "core:test.command", x: 0, y: 0, angle: 0 },
        { uid: "p2", partId: "core:test.beam", x: 1, y: 0, angle: 0 },
        { uid: "p3", partId: "core:test.reactor.half", x: 0, y: 1, angle: 0 },
      ],
    };
    const s = w.addShip(d, c2);
    const t = addShip(w, [["core:test.big", 0, 0]], { position: vec2(20, 0) });
    s.weaponCommand = fire(vec2(20, 0));
    w.run(2);
    expect(s.power.groups.weapons.demand).toBe(60);
    expect(s.power.groups.weapons.factor).toBeCloseTo(0.5, 9);
    const hp0 = t.part("p1").hp;
    w.run(60);
    expect(hp0 - t.part("p1").hp).toBeCloseTo(50, 0);
    s.weaponCommand = fire(vec2(20, 0), [1], false);
    w.run(2);
    expect(s.power.groups.weapons.demand).toBe(0);
  });
});

describe("M4 weapons", () => {
  it("4.9 a 0.5 s weapon fires 20 shots in 10 s (±1)", () => {
    const w = new World({ seed: 1 });
    const s = addShip(w, [
      ["core:test.command", 0, 0],
      ["core:test.ammogun", 1, 0],
      ["core:test.magazine", 0, 1],
    ]);
    s.weaponCommand = fire(vec2(100, 0));
    w.run(600);
    expect(Math.abs(w.combat.stats.shots - 20)).toBeLessThanOrEqual(1);
  });

  it("4.10 the internal magazine refills from a magazine on its network only", () => {
    const w = new World({ seed: 1 });
    const s = addShip(w, [
      ["core:test.command", 0, 0],
      ["core:test.ammogun", 1, 0],
      ["core:test.insulator", 0, 1],
      ["core:test.magazine", 0, 2],
    ]);
    s.weaponCommand = fire(vec2(100, 0));
    w.run(60 * 20);
    expect(w.combat.stats.shots).toBe(10); // only the internal magazine
    expect(s.part("p4").ammo).toBe(100);
  });

  it("4.11 a turret with 45°/s traverse aligns to a target at 90° in 2 s (±1 tick)", () => {
    const w = new World({ seed: 1 });
    const s = addShip(w, [
      ["core:test.command", 0, 0],
      ["core:test.turret", 1, 0],
    ]);
    s.weaponCommand = fire(vec2(1, 100), [1], false);
    let ticks = 0;
    const turret = s.weapons[0]!;
    while (turret.aimError > COMBAT.turretAimTolerance && ticks < 600) {
      w.step();
      ticks++;
    }
    expect(Math.abs(ticks - 120)).toBeLessThanOrEqual(1);
  });

  it("turn rate is a per-turret parameter: 45°/s and 180°/s turrets on one ship align in 2 s and 0.5 s", () => {
    const w = new World({ seed: 1 });
    const s = addShip(w, [
      ["core:test.command", 0, 0],
      ["core:test.turret", 1, 0],
      ["core:test.turret.fast", -1, 0],
    ]);
    s.weaponCommand = fire(vec2(0, 100), [1], false);
    const slow = s.weapons.find((x) => x.def.traverseRate === 45)!;
    const fast = s.weapons.find((x) => x.def.traverseRate === 180)!;
    const aligned = new Map<string, number>();
    for (let t = 1; t <= 300; t++) {
      w.step();
      for (const ws of [slow, fast])
        if (!aligned.has(ws.uid) && ws.aimError <= COMBAT.turretAimTolerance) aligned.set(ws.uid, t);
    }
    expect(Math.abs(aligned.get(slow.uid)! - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(aligned.get(fast.uid)! - 30)).toBeLessThanOrEqual(1);
  });

  it("recoil gives the firing ship k·m·v of momentum backwards (k = momentumTransfer)", () => {
    const w = new World({ seed: 1 });
    const s = addShip(w, [
      ["core:test.tough.command", 0, 0],
      ["core:test.slowgun", 1, 0],
    ]);
    s.weaponCommand = fire(vec2(100, 0), [1], true);
    w.step();
    expect(w.combat.stats.shots).toBe(1);
    const p = w.physics.getBodyState(s.id).linearVelocity.x * s.massProps.mass;
    expect(p / (-10 * 100 * COMBAT.momentumTransfer)).toBeCloseTo(1, 3);
  });

  it("4.12 a turret never fires into a range blocked by its own ship", () => {
    const w = new World({ seed: 1 });
    // Turret at the origin with a block 2 m to its right side.
    const s = addShip(w, [
      ["core:test.command", -1, 0],
      ["core:test.turret", 0, 0],
      ["core:test.square", 0, -1],
      ["core:test.square", 0, -2],
    ]);
    const turret = s.weapons[0]!;
    expect(turret.blocked.length).toBeGreaterThan(0);
    const rng = new Rng(7);
    for (let i = 0; i < 40; i++) {
      const a = rng.range(-Math.PI, Math.PI);
      s.weaponCommand = fire(vec2(Math.cos(a) * 50, Math.sin(a) * 50));
      const before = w.combat.projectiles.length;
      w.run(15);
      for (const pr of w.combat.projectiles.slice(before)) {
        const rel = angleOf(pr.vel) - 0;
        expect(turret.blocked.some(([lo, hi]) => rel >= lo + 1e-3 && rel <= hi - 1e-3)).toBe(false);
      }
    }
    // No damage to its own parts.
    expect(s.parts.every((p) => p.hp === p.def.def.hp)).toBe(true);
  });

  it("4.13 an AI-mode turret leads a crossing target: hit rate > 95 %", () => {
    const w = new World({ seed: 1 });
    const s = addShip(
      w,
      [
        ["core:test.command", 0, 0],
        ["core:test.turret", 1, 0],
      ],
      { modes: { "1": "ai" } },
    );
    // Target can still move (engine + fuel), so it is not defeated and the AI engages it.
    addShip(
      w,
      [
        ["core:test.tough.command", 0, 0],
        ["core:test.big", 0, 1],
        ["core:test.big", 0, -1],
        ["core:test.tough.engine", -1, 0],
        ["core:test.tough.tank", 1, 0],
      ],
      { position: vec2(300, -150), velocity: vec2(0, 30), team: 1 },
    );
    w.run(60 * 8);
    const { shots, hits } = w.combat.stats;
    // Rounds still in flight at the end are not misses.
    const resolved = shots - w.combat.projectiles.length;
    expect(resolved).toBeGreaterThan(30);
    expect(hits / resolved).toBeGreaterThan(0.95);
    expect(intercept(vec2(0, 0), vec2(0, 0), vec2(100, 0), vec2(0, 10), 1000)).not.toBeNull();
    void s;
  });

  it("4.14 only selected manual groups fire; hold groups never; unselected manual groups don't", () => {
    const w = new World({ seed: 1 });
    const s = addShip(
      w,
      [
        ["core:test.command", 0, 0],
        ["core:test.fastgun", 1, 0],
        ["core:test.fastgun", 0, 1, 90],
        ["core:test.fastgun", 0, -1, -90],
      ],
      {
        groups: { 2: 1, 3: 2, 4: 3 },
        modes: { "3": "hold" },
      },
    );
    s.weaponCommand = fire(vec2(100, 0), [1, 3]);
    w.run(3);
    const owners = new Set(w.combat.projectiles.map((p) => Math.round(angleOf(p.vel) * 10)));
    expect(owners).toEqual(new Set([0])); // only group 1 (forward gun); group 2 unselected, group 3 hold
  });

  it("4.15 a weapon at half HP fires half as often with twice the spread", () => {
    const w = new World({ seed: 1 });
    const s = addShip(w, [
      ["core:test.command", 0, 0],
      ["core:test.slowgun", 1, 0],
    ]);
    const ws = s.weapons[0]!;
    const full = weaponPerformance(ws);
    s.part("p2").hp = 50;
    const half = weaponPerformance(ws);
    expect(half.interval).toBeCloseTo(full.interval * 2, 9);
    expect(half.spread).toBeCloseTo(full.spread * 2, 9);
    expect(degToRad(0)).toBe(0);
  });
});

describe("M4 defeat", () => {
  it("4.17 destroying the command module defeats the ship", () => {
    const w = new World({ seed: 1 });
    const s = addShip(w, [
      ["core:test.command", 0, 0],
      ["core:test.engine", -1, 0],
      ["core:test.fueltank", 1, 0],
    ]);
    w.step();
    expect(s.defeated).toBe(false);
    s.applyDamage("p1", 1000);
    w.step();
    expect(s.defeated).toBe(true);
    expect(s.defeatReason).toBe("command-destroyed");
  });

  it("4.18 no propulsion and no usable weapons (gyro intact) → defeated; 4.19 a usable weapon keeps it active", () => {
    const w = new World({ seed: 1, enforceDefeat: true });
    const s = addShip(w, [
      ["core:test.command", 0, 0],
      ["core:test.engine", -1, 0],
      ["core:test.fueltank", 1, 0],
      ["core:test.ammogun", 0, 1, 90],
      ["core:test.gyro", 0, -1],
    ]);
    s.applyDamage("p2", 1000); // engine gone
    w.step();
    expect(s.defeated).toBe(false); // 4.19: the gun still has rounds
    s.part("p4").ammo = 0;
    w.step();
    expect(s.defeated).toBe(true);
    expect(s.defeatReason).toBe("incapacitated");
    // Enforced: a defeated ship no longer responds.
    w.setIntent(s.id, { thrust: vec2(0, 0), rotate: 1 });
    const w0 = w.physics.getBodyState(s.id).angularVelocity;
    w.run(30);
    expect(w.physics.getBodyState(s.id).angularVelocity).toBeCloseTo(w0, 9);
  });
});

describe("M4 performance", () => {
  it("4.23 500 projectiles + 10 ships: one tick under 4 ms", () => {
    const w = new World({ seed: 1 });
    for (let i = 0; i < 10; i++)
      addShip(
        w,
        [
          ["core:test.command", 0, 0],
          ["core:test.square", 1, 0],
          ["core:test.square", -1, 0],
          ["core:test.engine", 0, 1, 90],
          ["core:test.fueltank", 0, -1],
        ],
        { position: vec2(i * 40, 300) },
      );
    const refill = () => {
      while (w.combat.projectiles.length < 500) {
        const i = w.combat.projectiles.length;
        w.combat.projectiles.push({
          id: 10_000 + i,
          owner: "x",
          team: 9,
          pos: vec2(i * 2, -200),
          vel: vec2(0, 50),
          mass: 0.1,
          damage: 1,
          age: 0,
          lifetime: 1000,
          kind: "t",
        });
      }
    };
    refill();
    w.run(30);
    refill();
    const t0 = performance.now();
    const n = 120;
    for (let i = 0; i < n; i++) w.step();
    const ms = (performance.now() - t0) / n;
    console.log(`500 projectiles + 10 ships: ${ms.toFixed(2)} ms/tick`);
    expect(w.combat.projectiles.length).toBeGreaterThan(400);
    expect(ms).toBeLessThan(4);
    void length;
  });
});
