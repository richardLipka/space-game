import type { Catalogue, MissileDef, PartDef } from "../schemas/part";

/**
 * Balance model: one table of parameters and the formulas that turn a component's volume into its numbers
 * (mass, hit points, power, heat, fuel, ammunition, weapon damage, armor). The core catalogue is generated
 * from it (`npm run balance:derive`), a test keeps the two in step, and the simulation, the editor and the
 * AI use the same formulas for what happens at run time (a weapon's power demand, heat and damage rate,
 * hull cooling, fuel flow). Tune the game here; `npm run tuning` searches these parameters.
 *
 * Volume is the part's outline area times `depth` (the game is flat; every part is one deck high).
 *
 * The table holds exchange rates, not part values, and as many of them as possible are ratios:
 * - Hit points: structure has `hp.structure` HP per m³, the one fixed anchor of the scale; every other
 *   class is a multiple of it.
 * - Energy is counted in reference energy turrets (`energyTurret`, the small laser turret): a reactor makes
 *   `power.turretsPerVolume` turrets' worth per m³, a radiator sheds `heat.radiatorTurrets` per m³, the hull
 *   `heat.hullTurretsPerMetre` per metre of exposed outline. Every watt generated is a watt of heat.
 * - A magazine of `ammo.*.volumePerGame` m³ holds what one weapon fires in a game (`game.fireTime` seconds
 *   of continuous fire at the ammunition's reference interval).
 * - Weapon damage follows from the volume a weapon needs to fight: its own, the magazine that feeds it for a
 *   game, and the reactor and radiator volume its power and heat take (its system volume). One m³ of
 *   kinetic weapon system destroys one m³ of structure in `weapons.killTime` seconds; other families do
 *   `weapons.family.*` times that; long range and slow, heavy hits can cost or earn damage rate
 *   (`weapons.range`, `weapons.calibre`).
 * - Armor stops `armor.stop` seconds' worth of a 1 m³ kinetic system's damage from every hit, so it keeps
 *   its meaning when the pace changes.
 * - Engines and thrusters heat the ship by the fuel they burn (`heat.perKgFuel`); guns by a share of the
 *   muzzle energy (`heat.muzzleShare`). Ion engines trade thrust for power.
 * - Loading a missile or readying a drone costs energy by its mass (`ordnance.loadEnergyPerKg`).
 *
 * A part can scale what the formulas give it with `balance` factors in the catalogue: its character
 * (a heavy turret, a fast light gun), never a substitute for a missing rule.
 */
export const BALANCE = {
  /** Height of every part (m): volume = outline area × depth. */
  depth: 1,
  game: {
    /** Seconds of continuous fire one weapon gets from one magazine of its ammunition's volumePerGame. */
    fireTime: 143.585,
  },
  /** Dry mass per volume (kg/m³) by component class. */
  density: {
    structure: 60,
    armor: 160,
    command: 135,
    engine: 200,
    ionEngine: 260,
    thruster: 60,
    gyro: 120,
    reactor: 270,
    battery: 90,
    radiator: 60,
    heatSink: 200,
    tank: 30,
    magazine: 40,
    weapon: 170,
    hangar: 100,
    decoy: 40,
  },
  /**
   * Hit points. `structure` is HP per m³ and anchors the whole scale (damage is measured against it); the
   * other classes are multiples of it. `systems` scales every class listed under `system` at once.
   */
  hp: {
    structure: 324,
    armor: 2.14474,
    command: 3.04976,
    weapon: 3.70292,
    systems: 1.46017,
    system: {
      engine: 1.66976,
      ionEngine: 1.33642,
      thruster: 1.66667,
      gyro: 1.33642,
      reactor: 1.85185,
      battery: 1,
      radiator: 0.666667,
      heatSink: 2.00309,
      tank: 1,
      magazine: 1.33642,
      hangar: 1.11111,
      decoy: 1.33333,
    },
    /**
     * Missile HP follows point-defense fire, not structure: one kg of missile withstands `pdSecondsPerKg`
     * seconds of fire from one m³ of point-defense system at the reference range and fire interval. A faster
     * pace or stronger point defense therefore leaves missiles exactly as hard to stop.
     */
    missile: {
      pdSecondsPerKg: 0.0029,
      pdRange: 600,
      pdInterval: 0.03,
    },
  },
  power: {
    /** Reactor output per volume, in reference energy turrets per m³. */
    turretsPerVolume: 0.946424,
    /** Heat made per watt generated (1 = all generated energy ends up as heat on board). */
    heatPerWatt: 1,
    /** A command module's built-in reactor, as a share of a reactor of its volume. */
    commandShare: 0.15,
    battery: {
      /** Stored energy per volume (J/m³), and the seconds a full charge or discharge takes at most. */
      energyPerVolume: 2_000_000,
      chargeTime: 10,
      dischargeTime: 5,
    },
  },
  /**
   * Reference energy turret (the small laser turret): the unit power and cooling are counted in. A beam
   * weapon draws `powerDraw` per `volume` m³ of weapon (times its output factor).
   */
  energyTurret: {
    powerDraw: 200_000,
    volume: 1.59093,
  },
  heat: {
    /** Energy turrets whose heat one m³ of radiator sheds. */
    radiatorTurrets: 1.88621,
    /** Energy turrets' heat each metre of exposed hull outline sheds by itself: small ships need no radiators. */
    hullTurretsPerMetre: 0.00875109,
    /** Heat a heat sink stores per volume (J/m³). */
    sinkPerVolume: 20_000_000,
    /** Heat from burning one kilogram of fuel in an engine or thruster (J/kg). */
    perKgFuel: 7141.84,
    /** Share of a round's muzzle energy (½·m·v²) left in the gun as heat. */
    muzzleShare: 0.00686347,
    /** Extra heat of a beam weapon as a share of its power draw (its power is already heat at the reactor). */
    beamExtra: 0,
  },
  fuel: {
    /** Fuel a tank holds per volume (kg/m³). */
    perVolume: 500,
  },
  engine: {
    /** Thrust = thrustBase · V^thrustExponent (N): bigger engines are more efficient per volume. */
    thrustBase: 23_600,
    thrustExponent: 1.3,
    /** Specific impulse = ispBase · V^ispExponent (s). */
    ispBase: 720,
    ispExponent: 0.05,
  },
  thruster: {
    thrustPerVolume: 12_000,
    isp: 512,
  },
  ion: {
    /** Thrust as a share of a chemical engine of the same volume. */
    thrustShare: 0.15,
    /** Specific impulse (s): almost no fuel. */
    isp: 12_000,
    /** Electric power per newton of thrust (W/N). */
    powerPerNewton: 30,
  },
  /**
   * Stowed gun ammunition per magazine volume (kg/m³): a full magazine weighs the same whatever the
   * calibre, so a round's stowed mass is this divided by the rounds that fit.
   */
  ammoDensity: 360,
  /**
   * Ammunition: the reference fire interval (s) a magazine is sized for and the magazine volume (m³) that
   * lasts one weapon one game. Missiles also give the mass of one round (their flight mass, kg) and factors
   * on the warhead and the HP the formulas give them.
   */
  ammo: {
    "kinetic-120": { interval: 2, volumePerGame: 1 },
    "autocannon-30": { interval: 0.12, volumePerGame: 1 },
    "pd-20": { interval: 0.03, volumePerGame: 1 },
    "flak-40": { interval: 0.25, volumePerGame: 1 },
    "missile-smart": { interval: 10, volumePerGame: 1.5, roundMass: 90, warhead: 1, hp: 1 },
    "missile-rocket": { interval: 5, volumePerGame: 1.5, roundMass: 45, warhead: 1.1583, hp: 1.33333 },
  } as Record<
    string,
    { interval: number; volumePerGame: number; roundMass?: number; warhead?: number; hp?: number }
  >,
  weapons: {
    /** Rounds a gun holds itself, as a share of what it fires in a game. */
    internalShare: 0.1,
    /** Seconds one m³ of kinetic weapon system takes to destroy one m³ of structure: the pace of fights. */
    killTime: 2.06948,
    /** Damage rate per m³ of weapon system by family, as a multiple of kinetic weapons. */
    family: {
      kinetic: 1,
      beam: 0.21,
      missile: 1.04246,
      pd: 3.23015,
    },
    /** Damage rate × (range ÷ reference)^−exponent: a positive exponent makes long range cost damage. */
    range: {
      reference: 1500,
      exponent: 0.43494,
    },
    /** Damage rate × (fire interval ÷ reference)^exponent: a positive exponent favours slow, heavy hits. */
    calibre: {
      referenceInterval: 0.12,
      exponent: 0.0273402,
    },
    /** Volume of the launcher a missile's system volume counts (m³). */
    launcherVolume: 1.5,
  },
  armor: {
    /** Seconds of a 1 m³ kinetic weapon system's damage one armor plate stops from every hit. */
    stop: 0.190504,
  },
  ordnance: {
    /** Energy to load one missile into a launcher or ready one drone in a hangar, per kg (J/kg). */
    loadEnergyPerKg: 2_500,
    /** Mass a launcher and a hangar are sized for (kg): sets their rated power while loading. */
    refMissileMass: 90,
    refDroneMass: 150,
  },
} as const;

/** The parameter table with every number widened, so tuning tools can build variants of it. */
type Widen<T> = T extends number ? number : { readonly [K in keyof T]: Widen<T[K]> };
export type Balance = Widen<typeof BALANCE>;

export const G0 = 9.80665;

const nice = (v: number): number => (v === 0 ? 0 : Number(v.toPrecision(3)));
/** Damage keeps four significant digits (small rounds like 22.83 matter against armor). */
const nice4 = (v: number): number => (v === 0 ? 0 : Number(v.toPrecision(4)));
const whole = (v: number): number => Math.max(1, Math.round(v));

/** Volume of a part (m³): its outline area times the deck height. */
export function partVolume(p: Pick<PartDef, "outline">, B: Balance = BALANCE): number {
  const o = p.outline;
  let a = 0;
  for (let i = 0; i < o.length; i++) {
    const [x1, y1] = o[i]!;
    const [x2, y2] = o[(i + 1) % o.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return (Math.abs(a) / 2) * B.depth;
}

export type ComponentClass = keyof (typeof BALANCE)["density"];

/** Which row of the density and hit-point tables a part uses. */
export function componentClass(p: PartDef): ComponentClass {
  if (p.command) return "command";
  if (p.engine) return p.engine.ion ? "ionEngine" : "engine";
  if (p.thruster) return "thruster";
  if (p.gyro) return "gyro";
  if (p.reactor) return "reactor";
  if (p.battery) return "battery";
  if (p.radiator) return "radiator";
  if (p.heatSink) return "heatSink";
  if (p.fuelTank) return "tank";
  if (p.magazine) return "magazine";
  if (p.weapon) return "weapon";
  if (p.hangar) return "hangar";
  if (p.decoy) return "decoy";
  return p.category === "armor" ? "armor" : "structure";
}

/// ---------- formulas ----------

/** Hit points per m³ of a component class. */
export function hpPerVolume(cls: ComponentClass, B: Balance = BALANCE): number {
  const h = B.hp;
  if (cls === "structure") return h.structure;
  if (cls === "armor" || cls === "command" || cls === "weapon") return h.structure * h[cls];
  return h.structure * h.systems * h.system[cls];
}

/** Rounds a magazine of volume V holds. */
export function magazineCapacity(ammoType: string, volume: number, B: Balance = BALANCE): number {
  const a = B.ammo[ammoType];
  if (!a) throw new Error(`No ammunition "${ammoType}" in the balance model`);
  return whole(((B.game.fireTime / a.interval) * volume) / a.volumePerGame);
}

/** Stowed mass of one round (kg): a missile's own mass, or the ammunition density shared out. */
export function roundMass(ammoType: string, B: Balance = BALANCE): number {
  const a = B.ammo[ammoType];
  if (!a) throw new Error(`No ammunition "${ammoType}" in the balance model`);
  return a.roundMass ?? nice((B.ammoDensity * a.volumePerGame) / (B.game.fireTime / a.interval));
}

/** Rounds a gun holds itself. */
export function internalRounds(fireInterval: number, share: number, B: Balance = BALANCE): number {
  return whole((B.game.fireTime / fireInterval) * share);
}

/** Reactor output of volume V (W). */
export const reactorOutput = (volume: number, B: Balance = BALANCE): number =>
  B.power.turretsPerVolume * B.energyTurret.powerDraw * volume;

/** Heat a radiator of volume V sheds, extended (W). */
export const radiatorDissipation = (volume: number, B: Balance = BALANCE): number =>
  B.heat.radiatorTurrets * B.energyTurret.powerDraw * B.power.heatPerWatt * volume;

/** Heat every metre of exposed hull outline sheds (W/m). */
export const hullPerMetre = (B: Balance = BALANCE): number =>
  B.heat.hullTurretsPerMetre * B.energyTurret.powerDraw;

/** Power a beam weapon of volume V draws while firing (W), before its output factor. */
export const beamPowerDraw = (volume: number, B: Balance = BALANCE): number =>
  (B.energyTurret.powerDraw * volume) / B.energyTurret.volume;

export const chemicalThrust = (volume: number, B: Balance = BALANCE): number =>
  B.engine.thrustBase * Math.pow(volume, B.engine.thrustExponent);

export const chemicalIsp = (volume: number, B: Balance = BALANCE): number =>
  B.engine.ispBase * Math.pow(volume, B.engine.ispExponent);

/** Fuel burned at full thrust (kg/s). */
export const fuelFlow = (thrust: number, isp: number): number => thrust / (isp * G0);

/** Effective specific impulse of engines burning `flow` kg/s for `thrust` N together (s). */
export const effectiveIsp = (thrust: number, flow: number): number => (flow > 0 ? thrust / (flow * G0) : 0);

/** Velocity change from burning `fuel` kg of a ship of `mass` kg (rocket equation, m/s). */
export const deltaV = (isp: number, mass: number, fuel: number): number =>
  isp > 0 && fuel > 0 ? isp * G0 * Math.log(mass / Math.max(1e-6, mass - fuel)) : 0;

/** Heat of an engine or thruster at full thrust (W): by the fuel it burns. */
export const burnHeat = (thrust: number, isp: number, B: Balance = BALANCE): number =>
  fuelFlow(thrust, isp) * B.heat.perKgFuel;

/** Heat left in a gun by one shot (J). */
export const shotHeat = (roundMass: number, speed: number, B: Balance = BALANCE): number =>
  0.5 * roundMass * speed * speed * B.heat.muzzleShare;

/** Energy to load a missile or ready a drone of this mass (J). */
export const loadEnergy = (mass: number, B: Balance = BALANCE): number => B.ordnance.loadEnergyPerKg * mass;

// ---------- weapons: what the whole app reads ----------

type WeaponRates = Pick<
  NonNullable<PartDef["weapon"]>,
  "fireInterval" | "powerDraw" | "powerPerShot" | "heatPerShot" | "heatWhileFiring"
>;

/** Average power a weapon draws while it fires or reloads (W): beams continuously, launchers per load. */
export const weaponPowerDemand = (w: WeaponRates): number =>
  (w.powerDraw ?? 0) + (w.powerPerShot ?? 0) / w.fireInterval;

/** Heat a weapon adds while it fires (W). */
export const weaponHeatRate = (w: WeaponRates): number =>
  (w.heatWhileFiring ?? 0) + (w.heatPerShot ?? 0) / w.fireInterval;

/**
 * Nominal damage per second of a gun or beam (every round on target, no armor). Missiles' damage is their
 * magazine's: pass the missile to count it per launcher interval.
 */
export function weaponDps(
  w: NonNullable<PartDef["weapon"]>,
  missile?: Pick<MissileDef, "damage" | "reload">,
): number {
  if (w.beam) return w.beam.dps;
  if (w.projectile) return w.projectile.damage / w.fireInterval;
  if (missile) return missile.damage / (w.fireInterval * (missile.reload ?? 1));
  return 0;
}

export type WeaponFamily = keyof (typeof BALANCE)["weapons"]["family"];

export function weaponFamily(w: NonNullable<PartDef["weapon"]>): WeaponFamily {
  if (w.kind === "pd") return "pd";
  if (w.kind === "beam") return "beam";
  if (w.kind === "missile") return "missile";
  return "kinetic";
}

/** Damage per second one m³ of kinetic weapon system deals: the pace of the game (HP/s per m³). */
export const kineticRate = (B: Balance = BALANCE): number => B.hp.structure / B.weapons.killTime;

/**
 * A weapon's system volume (m³): the weapon, the magazine that feeds it one game (unless it carries its whole
 * game's rounds itself), and the reactor and radiator volume its average power and heat need.
 */
export function systemVolume(
  volume: number,
  w: NonNullable<PartDef["weapon"]>,
  internalShare: number,
  B: Balance = BALANCE,
): number {
  const mag =
    w.ammoType && w.ammoType !== "missile" && internalShare < 1 ? B.ammo[w.ammoType]!.volumePerGame : 0;
  const power = weaponPowerDemand(w);
  const heat = weaponHeatRate(w) + power * B.power.heatPerWatt;
  return volume + mag + power / reactorOutput(1, B) + heat / radiatorDissipation(1, B);
}

/** Damage per second of one m³ of system volume of a weapon of this family, range and fire interval. */
export function damageRate(
  family: WeaponFamily,
  range: number,
  fireInterval: number,
  B: Balance = BALANCE,
): number {
  const W = B.weapons;
  const r = Math.pow(range / W.range.reference, -W.range.exponent);
  const c = Math.pow(fireInterval / W.calibre.referenceInterval, W.calibre.exponent);
  return kineticRate(B) * W.family[family] * r * c;
}

/** Armor rating (damage stopped per hit) of a plate with this factor. */
export const armorRating = (factor: number, B: Balance = BALANCE): number =>
  B.armor.stop * kineticRate(B) * factor;

/** A missile's HP per kg: the reference point-defense system's damage over `pdSecondsPerKg` seconds. */
export function missileHpPerKg(B: Balance = BALANCE): number {
  const m = B.hp.missile;
  return damageRate("pd", m.pdRange, m.pdInterval, B) * m.pdSecondsPerKg;
}

/**
 * The missiles a magazine can hold, by ammunition id. Smart missiles steer for as long as their motor
 * burns; rockets fly straight where the launcher points, are half the size and reload twice as fast.
 * A warhead is the damage a missile system (launcher, magazine, loading power) deals over one reload,
 * every missile hitting, at the missile family's rate.
 */
export function missileDef(ammoType: string, B: Balance = BALANCE): MissileDef | null {
  const a = B.ammo[ammoType];
  if (!a || !ammoType.startsWith("missile-")) return null;
  const mass = roundMass(ammoType, B);
  const load = loadEnergy(B.ordnance.refMissileMass, B) / a.interval;
  const vSys = B.weapons.launcherVolume + a.volumePerGame + load / reactorOutput(1, B);
  const damage = nice4(kineticRate(B) * B.weapons.family.missile * vSys * a.interval * (a.warhead ?? 1));
  const hp = nice(missileHpPerKg(B) * mass * (a.hp ?? 1));
  const reload = a.interval / B.ammo["missile-smart"]!.interval;
  if (ammoType === "missile-smart")
    return {
      name: "Smart missile",
      mass,
      thrust: 6000,
      fuel: 8,
      turnRate: 120,
      hp,
      damage,
      proximityFuse: 6,
      blastRadius: 5,
      guidance: "pn",
      navConstant: 3.5,
      reload,
    };
  return {
    name: "Rocket",
    mass,
    thrust: 5400,
    fuel: 4,
    turnRate: 1,
    hp,
    damage,
    proximityFuse: 5,
    blastRadius: 4,
    guidance: "none",
    reload,
  };
}

/** Applies the formulas to one part. Numbers the model does not cover (ranges, rates, speeds) are kept. */
export function derivePart(part: PartDef, B: Balance = BALANCE): PartDef {
  const p: PartDef = structuredClone(part);
  const V = partVolume(p, B);
  const f = p.balance ?? {};
  const out = f.output ?? 1;
  const cls = componentClass(p);
  p.mass = nice(B.density[cls] * V * (f.mass ?? 1));
  p.hp = nice(hpPerVolume(cls, B) * V * (f.hp ?? 1));
  if (p.armor !== undefined) p.armor = nice(armorRating(f.armor ?? 1, B));

  if (p.reactor) {
    const share = p.command ? B.power.commandShare : 1;
    p.reactor = {
      ...p.reactor,
      maxOutput: nice(reactorOutput(V, B) * share * out),
      heatPerWatt: B.power.heatPerWatt,
    };
  }
  if (p.battery) {
    const capacity = nice(B.power.battery.energyPerVolume * V * out);
    p.battery = {
      capacity,
      maxCharge: nice(capacity / B.power.battery.chargeTime),
      maxDischarge: nice(capacity / B.power.battery.dischargeTime),
    };
  }
  if (p.radiator) p.radiator = { ...p.radiator, dissipation: nice(radiatorDissipation(V, B) * out) };
  if (p.heatSink) p.heatSink = { capacity: nice(B.heat.sinkPerVolume * V * out) };
  if (p.fuelTank) p.fuelTank = { capacity: nice(B.fuel.perVolume * V * out) };
  if (p.engine) {
    const ion = !!p.engine.ion;
    const thrust = nice(chemicalThrust(V, B) * (ion ? B.ion.thrustShare : 1) * out);
    const isp = nice(ion ? B.ion.isp : chemicalIsp(V, B));
    p.engine = {
      ...p.engine,
      thrust,
      isp,
      powerDraw: ion ? nice(thrust * B.ion.powerPerNewton) : 0,
      heatAtMax: nice(burnHeat(thrust, isp, B)),
    };
  }
  if (p.thruster) {
    const thrust = nice(B.thruster.thrustPerVolume * V * out);
    p.thruster = {
      ...p.thruster,
      thrust,
      isp: B.thruster.isp,
      heatAtMax: nice(burnHeat(thrust, B.thruster.isp, B)),
    };
  }
  if (p.magazine) {
    const type = p.magazine.ammoType;
    const missile = missileDef(type, B);
    p.magazine = {
      ammoType: type,
      capacity: whole(magazineCapacity(type, V, B) * out),
      massPerRound: roundMass(type, B),
      ...(missile ? { missile } : {}),
    };
  }
  if (p.weapon) {
    const w = { ...p.weapon };
    const share = f.internalShare ?? B.weapons.internalShare;
    if (w.kind === "missile") {
      w.ammoType = "missile";
      w.internalMagazine = 0;
      w.powerPerShot = nice(loadEnergy(B.ordnance.refMissileMass, B));
      delete w.missile;
    } else if (w.projectile) {
      w.internalMagazine = internalRounds(w.fireInterval, share, B);
      w.heatPerShot = nice(shotHeat(w.projectile.mass, w.projectile.speed, B));
    } else if (w.beam) {
      w.powerDraw = nice(beamPowerDraw(V, B) * out);
      w.heatWhileFiring = nice((w.powerDraw ?? 0) * B.heat.beamExtra);
    }
    // Damage from the system volume, after power and heat are known.
    if (w.projectile || w.beam) {
      const dps =
        damageRate(weaponFamily(w), w.range, w.fireInterval, B) *
        systemVolume(V, w, share, B) *
        (f.damage ?? 1);
      if (w.beam) w.beam = { ...w.beam, dps: nice4(dps) };
      else if (w.projectile) {
        const damage = nice4(dps * w.fireInterval);
        w.projectile = {
          ...w.projectile,
          damage,
          ...(w.projectile.burstDamage !== undefined ? { burstDamage: nice4(damage * (f.burst ?? 1)) } : {}),
        };
      }
    }
    p.weapon = w;
  }
  if (p.hangar)
    p.hangar = {
      ...p.hangar,
      powerDraw: nice(loadEnergy(B.ordnance.refDroneMass, B) / p.hangar.launchInterval),
    };
  return p;
}

export function deriveCatalogue(c: Catalogue, B: Balance = BALANCE): Catalogue {
  return { ...c, parts: c.parts.map((p) => derivePart(p, B)) };
}
