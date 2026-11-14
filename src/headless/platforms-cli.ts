/**
 * Writes the test platforms (src/data/designs/platforms/*.json): stationary ships with one kind of weapon
 * each, plus targets, for tuning and test scenarios. Built on a grid around a 1.5 m command module at the
 * origin, front (+x) towards the enemy.
 *
 *   npx tsx src/headless/platforms-cli.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import type { PartPlacement, ShipDesign } from "../data/schemas/design";

type P = [uid: string, part: string, x: number, y: number, angle?: number];

/** Turret centre offset from the edge it stands on: half the octagon's width. */
const TURRET = { s: 0.6929, m: 1.0163, pd: 0.4619, flak: 0.5543, light: 0.5098 } as const;
const C = 0.75; // half the command module

/**
 * Every platform has a fuel tank and a small engine behind its command module: with no pilot it stays put,
 * but a ship that can neither move nor fire at ships counts as defeated (spec §8.1) and nothing shoots at it.
 */
const DRIVE: P[] = [
  ["tank", "tank.fuel.s", -C - 0.5, 0],
  ["eng", "engine.main.s", -C - 1.5, 0],
];

function design(id: string, name: string, description: string, parts: P[]): ShipDesign {
  parts = [...parts, ...DRIVE];
  return {
    formatVersion: 1,
    id: `platform-${id}`,
    name,
    section: "Test platforms",
    description,
    createdAt: "2026-11-14T00:00:00Z",
    modifiedAt: "2026-11-14T00:00:00Z",
    parts: parts.map(([uid, p, x, y, angle]): PartPlacement => ({
      uid,
      partId: `core:${p}`,
      x: Number(x.toFixed(4)),
      y: Number(y.toFixed(4)),
      angle: angle ?? 0,
    })),
    weaponGroupModes: { "1": "ai" },
    powerPriority: ["gyro", "pointDefense", "weapons", "propulsion", "hangar"],
  };
}

/** A turret on the command module's front face, its magazine on top. */
const turretPlatform = (id: string, name: string, desc: string, turret: string, r: number, mag: string) =>
  design(id, name, desc, [
    ["cmd", "command.s", 0, 0],
    ["mag", mag, 0, C + 0.5],
    ["gun", turret, C + r, 0],
  ]);

const platforms: ShipDesign[] = [
  turretPlatform(
    "gatling",
    "Gatling platform (1 PD)",
    "One point-defense gatling and its magazine. Should stop one incoming missile; a second has a chance to pass.",
    "weapon.pd.gatling.s",
    TURRET.pd,
    "magazine.pd.s",
  ),
  design(
    "gatling-2",
    "Gatling platform (2 PD)",
    "Two point-defense gatlings. Should stop two incoming missiles; a third has a chance to pass.",
    [
      ["cmd", "command.s", 0, 0],
      ["hull-t", "hull.rect.m", 0, C + 0.5],
      ["mag", "magazine.pd.s", 0, C + 1.5],
      ["mag-2", "magazine.pd.s", 0, -C - 1.5],
      ["sink", "heatsink.s", C + 0.5, 0],
      ["hull-b", "hull.rect.m", 0, -C - 0.5],
      ["gun-t", "weapon.pd.gatling.s", 1 + TURRET.pd, C + 0.5],
      ["gun-b", "weapon.pd.gatling.s", 1 + TURRET.pd, -C - 0.5],
    ],
  ),
  turretPlatform(
    "flak",
    "Flak platform",
    "One flak turret and its magazine: bursts that hit every missile near them.",
    "weapon.pd.flak.s",
    TURRET.flak,
    "magazine.flak.s",
  ),
  design("launcher", "Missile launcher platform", "One launcher with smart missiles for a whole game.", [
    ["cmd", "command.s", 0, 0],
    ["mag", "magazine.missile.s", 0, C + 0.5],
    ["mag-2", "magazine.missile.s", 0, -C - 0.5],
    ["gun", "weapon.missile.launcher.s", C + 0.75, 0],
  ]),
  design("rocket", "Rocket launcher platform", "One launcher with unguided rockets.", [
    ["cmd", "command.s", 0, 0],
    ["mag", "magazine.rocket.s", 0, C + 0.5],
    ["mag-2", "magazine.rocket.s", 0, -C - 0.5],
    ["gun", "weapon.missile.launcher.s", C + 0.75, 0],
  ]),
  turretPlatform(
    "autocannon",
    "Autocannon platform",
    "One autocannon turret (S) and its magazine: the kinetic reference.",
    "weapon.autocannon.turret.s",
    TURRET.s,
    "magazine.autocannon.s",
  ),
  design(
    "laser",
    "Laser platform",
    "One laser turret (S) with its reactor and radiators: the beam reference. No ammunition.",
    [
      ["cmd", "command.s", 0, 0],
      ["reactor", "reactor.s", 0, -2 * C],
      ["rad-t", "radiator.s", 0, C + 1, 90],
      ["rad-b", "radiator.s", 0, -3 * C - 1, -90],
      ["gun", "weapon.laser.turret.s", C + TURRET.s, 0],
    ],
  ),
  design("cannon", "Cannon turret platform", "One medium cannon turret and its magazine: slow, heavy hits.", [
    ["cmd", "command.s", 0, 0],
    ["mag", "magazine.kinetic.s", 0, C + 0.5],
    ["sink", "heatsink.s", 0, -C - 0.5],
    ["gun", "weapon.cannon.turret.m", C + TURRET.m, 0],
  ]),
  design("target", "Target block", "Unarmed, unarmored structure to shoot at.", [
    ["cmd", "command.s", 0, 0],
    ["h-f", "hull.square.m", C + 1, 0],
    ["h-t", "hull.square.s", 0, C + 0.5],
    ["h-d", "hull.square.s", 0, -C - 0.5],
  ]),
  design("target-armored", "Armored target", "The target block behind medium armor plates.", [
    ["cmd", "command.s", 0, 0],
    ["h-f", "hull.square.m", C + 1, 0],
    ["h-t", "hull.square.s", 0, C + 0.5],
    ["h-d", "hull.square.s", 0, -C - 0.5],
    ["a-f", "armor.square.m", C + 3, 0],
    ["a-t", "armor.square.m", 0, C + 2],
    ["a-d", "armor.square.m", 0, -C - 2],
  ]),
];

mkdirSync("src/data/designs/platforms", { recursive: true });
for (const d of platforms) {
  const file = `src/data/designs/platforms/${d.id.replace(/^platform-/, "")}.json`;
  writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
  console.log(file);
}
