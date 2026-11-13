import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ShipDesign } from "../../src/data/schemas/design";
import type { Catalogue, PartDef } from "../../src/data/schemas/part";
import { validateCatalogue, validateDesign } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { World } from "../../src/sim/world";
import { length, sub, vec2 } from "../../src/sim/core/vec2";
import { SIM_DT } from "../../src/sim/core/loop";
import { DRONE, MISSILE } from "../../src/sim/combat/constants";
import { spawnMissile, stepMissiles } from "../../src/sim/combat/missiles";
import { capabilities } from "../../src/sim/flight/propulsion";
import {
  BALANCE,
  burnHeat,
  chemicalThrust,
  deriveCatalogue,
  fuelFlow,
  loadEnergy,
  magazineCapacity,
  partVolume,
  radiatorDissipation,
  reactorOutput,
  shotHeat,
} from "../../src/data/balance/model";

const read = (p: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../src/data/${p}`, import.meta.url), "utf8"));
const catR = validateCatalogue(read("core/catalogue.json"));
if (!catR.ok) throw new Error(catR.errors.join("\n"));
const raw: Catalogue = catR.value;
const cat = PartCatalogue.fromJson(raw);
const part = (id: string): PartDef => raw.parts.find((p) => p.id === `core:${id}`)!;
const design = (name: string): ShipDesign => {
  const r = validateDesign(read(`designs/${name}.json`));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value;
};
const D = (id: string, parts: [string, string, number, number, number?][]): ShipDesign => ({
  formatVersion: 1,
  id,
  name: id,
  createdAt: "2026-11-13T00:00:00Z",
  modifiedAt: "2026-11-13T00:00:00Z",
  parts: parts.map(([uid, p, x, y, a]) => ({ uid, partId: `core:${p}`, x, y, angle: a ?? 0 })),
  weaponGroupModes: {},
  powerPriority: ["gyro", "propulsion", "pointDefense", "weapons", "hangar"],
});
const block = D("block", [
  ["cmd", "command.s", 0, 0],
  ["h1", "hull.square.m", -1.75, 0],
  ["h2", "hull.square.m", 1.75, 0],
]);
const hp = (ship: { parts: { hp: number }[] }) => ship.parts.reduce((s, p) => s + Math.max(0, p.hp), 0);

describe("balance model: the catalogue follows the formulas", () => {
  it("the core catalogue is exactly what the model derives (run `npm run balance:derive` after a change)", () => {
    expect(deriveCatalogue(raw)).toEqual(raw);
  });

  it("volume is the outline area times the deck height", () => {
    expect(partVolume(part("hull.square.s"))).toBeCloseTo(1, 9);
    expect(partVolume(part("hull.square.m"))).toBeCloseTo(4, 9);
    expect(partVolume(part("reactor.s"))).toBeCloseTo(2.25, 9);
  });

  it("a small magazine feeds one weapon for one game", () => {
    for (const [mag, gun] of [
      ["magazine.kinetic.s", "weapon.cannon.fixed.m"],
      ["magazine.autocannon.s", "weapon.autocannon.turret.s"],
      ["magazine.pd.s", "weapon.pd.gatling.s"],
      ["magazine.flak.s", "weapon.pd.flak.s"],
    ] as const) {
      const m = part(mag).magazine!;
      const seconds = m.capacity * part(gun).weapon!.fireInterval;
      expect(seconds, mag).toBeCloseTo(BALANCE.game.fireTime, 0);
      // Every full gun magazine weighs the same per volume.
      expect(m.capacity * m.massPerRound, mag).toBeCloseTo(BALANCE.ammoDensity * partVolume(part(mag)), -1);
    }
    expect(magazineCapacity("kinetic-120", 2)).toBe(2 * magazineCapacity("kinetic-120", 1));
  });

  it("a reactor powers one energy turret per cubic metre, and all of it becomes heat", () => {
    const laser = part("weapon.laser.turret.s").weapon!;
    expect(laser.powerDraw).toBe(BALANCE.energyTurret.powerDraw);
    for (const id of ["reactor.s", "reactor.m"]) {
      const r = part(id);
      expect(r.reactor!.maxOutput).toBeCloseTo(reactorOutput(partVolume(r)), -3);
      expect(r.reactor!.maxOutput / laser.powerDraw!).toBeCloseTo(partVolume(r), 1);
      expect(r.reactor!.heatPerWatt).toBe(1);
    }
    // A beam weapon's heat is the power it draws: none of its own on top.
    expect(laser.heatWhileFiring).toBe(0);
  });

  it("a radiator cools two laser turrets, no more", () => {
    const rad = part("radiator.s");
    const laserHeat = part("weapon.laser.turret.s").weapon!.powerDraw! * BALANCE.power.heatPerWatt;
    expect(rad.radiator!.dissipation).toBe(radiatorDissipation(partVolume(rad)));
    expect(rad.radiator!.dissipation / laserHeat).toBeCloseTo(2, 6);
  });

  it("engines heat by the fuel they burn; guns by a share of the muzzle energy", () => {
    for (const id of ["engine.main.s", "engine.main.l", "engine.drone.xs", "engine.ion.s"]) {
      const e = part(id).engine!;
      // Catalogue numbers are rounded to three significant digits.
      expect(e.heatAtMax / (fuelFlow(e.thrust, e.isp) * BALANCE.heat.perKgFuel), id).toBeCloseTo(1, 2);
      expect(e.heatAtMax / burnHeat(e.thrust, e.isp), id).toBeCloseTo(1, 2);
    }
    const t = part("rcs.s").thruster!;
    expect(t.heatAtMax / burnHeat(t.thrust, t.isp)).toBeCloseTo(1, 2);
    const gun = part("weapon.cannon.fixed.m").weapon!;
    expect(gun.heatPerShot! / shotHeat(gun.projectile!.mass, gun.projectile!.speed)).toBeCloseTo(1, 2);
  });

  it("ion engines: a share of the thrust for almost no fuel, paid for in power", () => {
    const chem = part("engine.main.s").engine!;
    const ion = part("engine.ion.s").engine!;
    expect(ion.ion).toBe(true);
    expect(ion.thrust).toBeCloseTo(chemicalThrust(1.5) * BALANCE.ion.thrustShare, -2);
    expect(ion.thrust).toBeLessThan(chem.thrust * 0.2);
    expect(fuelFlow(ion.thrust, ion.isp)).toBeLessThan(fuelFlow(chem.thrust, chem.isp) * 0.02);
    expect(ion.powerDraw).toBeCloseTo(ion.thrust * BALANCE.ion.powerPerNewton, -3);
    expect(chem.powerDraw).toBe(0);
  });

  it("a smart missile's warhead is ten times a heavy kinetic round; a rocket's is smaller", () => {
    const smart = part("magazine.missile.s").magazine!.missile!;
    const rocket = part("magazine.rocket.s").magazine!.missile!;
    const shell = part("weapon.cannon.fixed.m").weapon!.projectile!;
    expect(smart.damage / shell.damage).toBeCloseTo(BALANCE.ordnance.damageFactor, 6);
    expect(smart.damage / shell.damage).toBeGreaterThanOrEqual(10);
    expect(rocket.damage).toBeLessThan(smart.damage);
    expect(smart.guidance).toBe("pn");
    expect(rocket.guidance).toBe("none");
    // Launchers hold nothing themselves and have no missile of their own.
    const launcher = part("weapon.missile.launcher.s").weapon!;
    expect(launcher.internalMagazine).toBe(0);
    expect(launcher.missile).toBeUndefined();
    expect(launcher.powerPerShot).toBe(loadEnergy(BALANCE.ordnance.refMissileMass));
  });
});

describe("missile types come from the magazines", () => {
  const boat = D("boat", [
    ["cmd", "command.s", 0, 0],
    ["ml", "weapon.missile.launcher.s", 1.5, 0],
    ["smart", "magazine.missile.s", 0, 1.25],
    ["rocket", "magazine.rocket.s", 0, -1.25],
    ["bat", "battery.s", -1.25, 0],
  ]);
  const launch = (w: World, a: { weaponCommand: unknown }, targetId: string | null) =>
    ((a as { weaponCommand: object }).weaponCommand = {
      trigger: false,
      aimPoint: null,
      selected: new Set([1]),
      targetId,
      launch: "one",
    });

  it("lists what the magazines hold, smart missiles first", () => {
    const w = new World({ seed: 1 });
    const a = w.addShip(boat, cat);
    w.step();
    expect(a.missileStock().map((s) => [s.type, s.name, s.count])).toEqual([
      ["missile-smart", "Smart missile", part("magazine.missile.s").magazine!.capacity],
      ["missile-rocket", "Rocket", part("magazine.rocket.s").magazine!.capacity],
    ]);
    expect(a.nextMissile("ml")!.guidance).toBe("pn");
    a.missileType = "missile-rocket";
    expect(a.nextMissile("ml")!.guidance).toBe("none");
  });

  it("launches the selected type, takes it from its magazine, and falls back when that type runs out", () => {
    const w = new World({ seed: 1 });
    const a = w.addShip(boat, cat);
    const t = w.addShip(block, cat, { position: vec2(3000, 0), team: 1 });
    const smart0 = a.part("smart").ammo;
    const rocket0 = a.part("rocket").ammo;
    a.missileType = "missile-rocket";
    launch(w, a, t.id);
    w.step();
    expect(w.combat.missiles).toHaveLength(1);
    expect(w.combat.missiles[0]!.def.guidance).toBe("none");
    expect(a.part("rocket").ammo).toBe(rocket0 - 1);
    expect(a.part("smart").ammo).toBe(smart0);
    // Rockets reload in half the time.
    const interval = part("weapon.missile.launcher.s").weapon!.fireInterval;
    expect(a.weapons[0]!.cooldown).toBeCloseTo(interval * 0.5, 1);
    // No rockets left: the launcher loads a smart missile instead.
    a.part("rocket").ammo = 0;
    w.run(60 * 6);
    launch(w, a, t.id);
    w.step();
    expect(w.combat.missiles.some((m) => m.def.guidance === "pn")).toBe(true);
    expect(a.part("smart").ammo).toBe(smart0 - 1);
  });

  it("a rocket flies straight where the launcher points; a smart missile turns to its target", () => {
    const fly = (type: string) => {
      const w = new World({ seed: 1 });
      const a = w.addShip(boat, cat);
      // Target well off the launcher's axis (+x).
      const t = w.addShip(block, cat, { position: vec2(1500, 900), team: 1 });
      a.missileType = type;
      launch(w, a, t.id);
      w.step();
      const m = w.combat.missiles[0]!;
      let maxY = 0;
      for (let i = 0; i < 60 * 12 && w.combat.missiles.includes(m); i++) {
        w.step();
        maxY = Math.max(maxY, Math.abs(m.pos.y));
      }
      return { maxY, hits: w.combat.stats.missileHits };
    };
    const rocket = fly("missile-rocket");
    expect(rocket.maxY).toBeLessThan(120); // only the launcher's spread
    expect(rocket.hits).toBe(0);
    const smart = fly("missile-smart");
    expect(smart.maxY).toBeGreaterThan(700);
    expect(smart.hits).toBe(1);
  });

  it("a rocket can be fired without a target; a smart missile cannot", () => {
    const w = new World({ seed: 1 });
    const a = w.addShip(boat, cat);
    launch(w, a, null);
    w.step();
    expect(w.combat.missiles).toHaveLength(0);
    a.missileType = "missile-rocket";
    launch(w, a, null);
    w.step();
    expect(w.combat.missiles).toHaveLength(1);
  });

  it("a smart missile does about ten times the damage of a cannon shell", () => {
    const w = new World({ seed: 1 });
    const a = w.addShip(boat, cat);
    const t = w.addShip(block, cat, { position: vec2(1200, 0), team: 1 });
    const before = hp(t);
    launch(w, a, t.id);
    for (let i = 0; i < 60 * 20 && w.combat.stats.missileHits === 0; i++) w.step();
    expect(w.combat.stats.missileHits).toBe(1);
    expect(before - hp(t)).toBeGreaterThan(part("weapon.cannon.fixed.m").weapon!.projectile!.damage * 5);
  });

  it("loading a missile takes power: the launcher draws it while reloading, and reloads slower without it", () => {
    const reloadTime = (design: ShipDesign) => {
      const w = new World({ seed: 1 });
      const a = w.addShip(design, cat);
      const t = w.addShip(block, cat, { position: vec2(3000, 0), team: 1 });
      launch(w, a, t.id);
      w.step();
      let demand = 0;
      let ticks = 0;
      while (a.weapons[0]!.cooldown > 1e-9 && ticks < 60 * 60) {
        w.step();
        demand = Math.max(demand, a.power.groups.weapons.demand);
        ticks++;
      }
      return { seconds: ticks / 60, demand };
    };
    const launcher = part("weapon.missile.launcher.s").weapon!;
    const powered = reloadTime(boat);
    expect(powered.seconds).toBeCloseTo(launcher.fireInterval, 0);
    expect(powered.demand).toBeCloseTo(launcher.powerPerShot! / launcher.fireInterval, -2);
    // Four launchers on the command module's small reactor alone: a brown-out, so the reload drags.
    const starved = D("starved", [
      ["cmd", "command.s", 0, 0],
      ["ml", "weapon.missile.launcher.s", 1.5, 0],
      ["ml2", "weapon.missile.launcher.s", -1.5, 0, 180],
      ["smart", "magazine.missile.s", 0, 1.25],
      ["ml3", "weapon.missile.launcher.s", 1.5, 1.25],
      ["ml4", "weapon.missile.launcher.s", -1.5, 1.25, 180],
    ]);
    const w = new World({ seed: 1 });
    const a = w.addShip(starved, cat);
    const t = w.addShip(block, cat, { position: vec2(3000, 0), team: 1 });
    a.weaponCommand = {
      trigger: false,
      aimPoint: null,
      selected: new Set([1]),
      targetId: t.id,
      launch: "salvo",
    };
    w.step();
    expect(w.combat.missiles).toHaveLength(4);
    w.run(60 * launcher.fireInterval);
    expect(a.power.groups.weapons.factor).toBeLessThan(1);
    expect(a.weapons[0]!.cooldown).toBeGreaterThan(1);
  });

  it("a missile that has burnt out destroys itself after ten seconds of coasting", () => {
    const w = new World({ seed: 1 });
    const a = w.addShip(boat, cat);
    const def = part("magazine.missile.s").magazine!.missile!;
    const m = spawnMissile(w, a, def, vec2(50, 0), vec2(1, 0), vec2(100, 0), null);
    m.fuel = 0;
    m.age = def.fuel;
    expect(MISSILE.selfDestructAfter).toBe(10);
    for (let i = 0; i < 60 * 10 - 5; i++) stepMissiles(w, SIM_DT);
    expect(w.combat.missiles).toContain(m);
    for (let i = 0; i < 10; i++) stepMissiles(w, SIM_DT);
    expect(w.combat.missiles).not.toContain(m);
    expect(w.combat.events.some((e) => e.kind === "missile-down")).toBe(true);
  });
});

describe("drones that can no longer shoot", () => {
  const carrier = D("carrier", [
    ["cmd", "command.s", 0, 0],
    ["hg", "hangar.attack.m", 0, 1.5],
    ["bat", "battery.s", 0, -1.25],
  ]);
  const setup = () => {
    const w = new World({ seed: 1, enforceDefeat: true });
    w.registerDesign(design("drone-attack"));
    const c = w.addShip(carrier, cat);
    // A ship that can still move: a hulk that is already defeated is not worth ramming.
    const t = w.addShip(design("demo-hauler"), cat, { position: vec2(600, 0), team: 1 });
    c.launchOneDrone();
    w.run(30);
    const d = w.allShips().find((s) => s.drone)!;
    return { w, c, t, d };
  };

  it("out of ammunition: it rams the nearest enemy and blows up at its hull", () => {
    const { w, t, d } = setup();
    for (const x of d.weapons) x.part.ammo = 0;
    const before = hp(t);
    let closest = Infinity;
    for (let i = 0; i < 60 * 40 && !d.defeated; i++) {
      w.step();
      closest = Math.min(
        closest,
        length(sub(w.physics.getWorldCenter(d.id), w.physics.getWorldCenter(t.id))),
      );
    }
    expect(d.defeated).toBe(true);
    expect(d.inertReason).toBe("self-destruct");
    expect(closest).toBeLessThan(t.layout.boundingRadius + DRONE.ramFuse + 2);
    expect(before - hp(t)).toBeGreaterThan(100);
    expect(w.combat.events.some((e) => e.kind === "explosion")).toBe(true);
  });

  it("weapons destroyed: the same", () => {
    const { w, t, d } = setup();
    for (const x of d.weapons) d.destroyPart(x.part.uid);
    const before = hp(t);
    for (let i = 0; i < 60 * 40 && !d.defeated; i++) w.step();
    expect(d.inertReason).toBe("self-destruct");
    expect(before - hp(t)).toBeGreaterThan(100);
  });

  it("no fuel and no ammunition: it destroys itself without hurting anyone", () => {
    const { w, t, c, d } = setup();
    for (const x of d.weapons) x.part.ammo = 0;
    for (const p of d.parts) p.fuel = 0;
    const before = hp(t) + hp(c);
    w.run(5);
    expect(d.inertReason).toBe("self-destruct");
    expect(d.parts.every((p) => p.hp <= 0)).toBe(true);
    expect(hp(t) + hp(c)).toBe(before);
  });

  it("no fuel but still armed: it only goes inert, as before", () => {
    const { w, d } = setup();
    for (const p of d.parts) p.fuel = 0;
    w.run(5);
    expect(d.inertReason).toBe("no-fuel");
    expect(d.parts.some((p) => p.hp > 0)).toBe(true);
  });
});

describe("ion engines and the drive mode", () => {
  /** A long hull with a chemical and an ion engine side by side at the stern (both within their gimbal). */
  const hybrid = D("hybrid", [
    ["cmd", "command.s", 0, 0],
    ["h1", "hull.square.m", -1.75, 0],
    ["h2", "hull.square.m", -3.75, 0],
    ["rx", "reactor.s", 0, 1.5],
    ["tank", "tank.fuel.s", 0, -1.25],
    ["chem", "engine.main.s", -5.25, 0.75],
    ["ion", "engine.ion.s", -5.25, -0.75],
  ]);
  const fly = (mode: "all" | "ion" | "chemical", seconds = 10) => {
    const w = new World({ seed: 1 });
    const s = w.addShip(hybrid, cat);
    s.driveMode = mode;
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    const fuel0 = s.totalFuel;
    let power = 0;
    for (let i = 0; i < 60 * seconds; i++) {
      w.step();
      power = Math.max(power, s.power.groups.propulsion.demand);
    }
    return {
      speed: length(w.physics.getBodyState(s.id).linearVelocity),
      fuel: fuel0 - s.totalFuel,
      power,
      fwd: capabilities(s.propulsion.actuators).fwd,
      heat: s.heatFlow.sources,
    };
  };

  it("the ship knows it has an ion engine; the default uses every engine", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(hybrid, cat);
    expect(s.hasIonEngines).toBe(true);
    expect(s.driveMode).toBe("all");
    expect(w.addShip(block, cat, { position: vec2(0, 50) }).hasIonEngines).toBe(false);
  });

  it("ion only: little thrust, almost no fuel, a lot of power (which the reactor turns into heat)", () => {
    const ion = fly("ion");
    const chem = fly("chemical");
    const e = part("engine.ion.s").engine!;
    // (Thrust through the centre of mass: a few percent are lost to the gimbal angle.)
    expect(ion.fwd / e.thrust).toBeGreaterThan(0.95);
    expect(ion.fwd / e.thrust).toBeLessThanOrEqual(1);
    expect(chem.fwd / part("engine.main.s").engine!.thrust).toBeGreaterThan(0.95);
    expect(ion.speed).toBeGreaterThan(5);
    expect(ion.speed).toBeLessThan(chem.speed * 0.25);
    expect(ion.fuel).toBeLessThan(chem.fuel * 0.02);
    expect(ion.power).toBeCloseTo(e.powerDraw, -4);
    expect(chem.power).toBe(0);
    // The ion engine's own heat is tiny; its power shows up as reactor heat.
    expect(ion.heat.reactors).toBeGreaterThan(e.powerDraw * 0.8);
    expect(ion.heat.propulsion).toBeLessThan(2000);
    expect(chem.heat.propulsion).toBeGreaterThan(30000);
  });

  it("all engines: the thrust of both", () => {
    const all = fly("all", 2);
    const both = part("engine.main.s").engine!.thrust + part("engine.ion.s").engine!.thrust;
    expect(all.fwd / both).toBeGreaterThan(0.95);
    expect(all.fwd / both).toBeLessThanOrEqual(1);
  });
});
