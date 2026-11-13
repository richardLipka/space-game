import type { Catalogue, MissileDef, PartDef } from "../schemas/part";

/**
 * Balance model: one table of parameters and the formulas that turn a component's volume into its numbers
 * (mass, hit points, power, heat, fuel, ammunition). The core catalogue is generated from it
 * (`npm run balance:derive`), a test keeps the two in step, and the simulation reads the same table for
 * what happens at run time (energy to load a missile or a drone). Tune the game here.
 *
 * Volume is the part's outline area times `depth` (the game is flat; every part is one deck high).
 *
 * How the parts relate:
 * - A magazine of `ammo.*.volumePerGame` m³ holds what one weapon fires in a game (`game.fireTime` seconds
 *   of continuous fire at the ammunition's reference interval).
 * - A reactor makes `power.perVolume` W per m³: one cubic metre runs one energy turret, the way one small
 *   magazine feeds one gun.
 * - Every watt a reactor makes is also a watt of heat (`power.heatPerWatt`). Beam weapons add none of
 *   their own: their heat is the power they draw.
 * - A radiator sheds the heat of `heat.radiatorTurrets` energy turrets per m³.
 * - Engines and thrusters heat the ship by the fuel they burn (`heat.perKgFuel`); guns by a share of the
 *   muzzle energy (`heat.muzzleShare`).
 * - Ion engines give a share of the thrust for almost no fuel and pay for it in power.
 * - Loading a missile or readying a drone costs energy by its mass (`ordnance.loadEnergyPerKg`).
 * - A missile warhead is `ordnance.damageFactor` times a heavy kinetic round.
 */
export const BALANCE = {
  /** Height of every part (m): volume = outline area × depth. */
  depth: 1,
  game: {
    /** Seconds of continuous fire one weapon gets from one magazine of its ammunition's volumePerGame. */
    fireTime: 120,
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
  /** Hit points per volume (HP/m³) by component class. */
  hp: {
    structure: 324,
    armor: 1081,
    command: 1920,
    engine: 541,
    ionEngine: 433,
    thruster: 540,
    gyro: 433,
    reactor: 600,
    battery: 324,
    radiator: 216,
    heatSink: 649,
    tank: 324,
    magazine: 433,
    weapon: 540,
    hangar: 360,
    decoy: 432,
  },
  power: {
    /** Reactor output per volume (W/m³): one m³ runs one reference energy turret. */
    perVolume: 200_000,
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
  /** Reference energy turret (the small laser turret): what reactors and radiators are sized against. */
  energyTurret: {
    powerDraw: 200_000,
  },
  heat: {
    /** Energy turrets whose heat one m³ of radiator sheds. */
    radiatorTurrets: 2,
    /** Heat every metre of exposed hull outline sheds by itself (W/m): small ships manage without radiators. */
    hullPerMetre: 2_500,
    /** Heat a heat sink stores per volume (J/m³). */
    sinkPerVolume: 20_000_000,
    /** Heat from burning one kilogram of fuel in an engine or thruster (J/kg). */
    perKgFuel: 12_000,
    /** Share of a round's muzzle energy (½·m·v²) left in the gun as heat. */
    muzzleShare: 0.012,
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
   * lasts one weapon one game. Missiles also give the mass of one round (their flight mass, kg).
   */
  ammo: {
    "kinetic-120": { interval: 2, volumePerGame: 1 },
    "autocannon-30": { interval: 0.12, volumePerGame: 1 },
    "pd-20": { interval: 0.03, volumePerGame: 1 },
    "flak-40": { interval: 0.25, volumePerGame: 1 },
    "missile-smart": { interval: 10, volumePerGame: 1.5, roundMass: 90 },
    "missile-rocket": { interval: 5, volumePerGame: 1.5, roundMass: 45 },
  } as Record<string, { interval: number; volumePerGame: number; roundMass?: number }>,
  weapons: {
    /** Rounds a gun holds itself, as a share of what it fires in a game. */
    internalShare: 0.1,
  },
  ordnance: {
    /** Energy to load one missile into a launcher or ready one drone in a hangar, per kg (J/kg). */
    loadEnergyPerKg: 2_500,
    /** Mass a launcher and a hangar are sized for (kg): sets their rated power while loading. */
    refMissileMass: 90,
    refDroneMass: 150,
    /** Damage of a heavy kinetic round, and how many times stronger a smart missile's warhead is. */
    kineticDamage: 400,
    damageFactor: 10,
    /** A rocket's warhead as a share of a smart missile's. */
    rocketWarheadShare: 0.6,
  },
} as const;

/** The parameter table with every number widened, so tuning tools can build variants of it. */
type Widen<T> = T extends number ? number : { readonly [K in keyof T]: Widen<T[K]> };
export type Balance = Widen<typeof BALANCE>;

export const G0 = 9.80665;

const nice = (v: number): number => (v === 0 ? 0 : Number(v.toPrecision(3)));
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

// ---------- formulas ----------

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

export const reactorOutput = (volume: number, B: Balance = BALANCE): number => B.power.perVolume * volume;

export const radiatorDissipation = (volume: number, B: Balance = BALANCE): number =>
  B.heat.radiatorTurrets * B.energyTurret.powerDraw * B.power.heatPerWatt * volume;

export const chemicalThrust = (volume: number, B: Balance = BALANCE): number =>
  B.engine.thrustBase * Math.pow(volume, B.engine.thrustExponent);

export const chemicalIsp = (volume: number, B: Balance = BALANCE): number =>
  B.engine.ispBase * Math.pow(volume, B.engine.ispExponent);

/** Fuel burned at full thrust (kg/s). */
export const fuelFlow = (thrust: number, isp: number): number => thrust / (isp * G0);

/** Heat of an engine or thruster at full thrust (W): by the fuel it burns. */
export const burnHeat = (thrust: number, isp: number, B: Balance = BALANCE): number =>
  fuelFlow(thrust, isp) * B.heat.perKgFuel;

/** Heat left in a gun by one shot (J). */
export const shotHeat = (roundMass: number, speed: number, B: Balance = BALANCE): number =>
  0.5 * roundMass * speed * speed * B.heat.muzzleShare;

/** Energy to load a missile or ready a drone of this mass (J). */
export const loadEnergy = (mass: number, B: Balance = BALANCE): number => B.ordnance.loadEnergyPerKg * mass;

/**
 * The missiles a magazine can hold, by ammunition id. Smart missiles steer for as long as their motor
 * burns; rockets fly straight where the launcher points, are half the size and reload twice as fast.
 */
export function missileDef(ammoType: string, B: Balance = BALANCE): MissileDef | null {
  const smart = B.ordnance.kineticDamage * B.ordnance.damageFactor;
  if (ammoType === "missile-smart")
    return {
      name: "Smart missile",
      mass: roundMass("missile-smart", B),
      thrust: 6000,
      fuel: 8,
      turnRate: 120,
      hp: 30,
      damage: nice(smart),
      proximityFuse: 6,
      blastRadius: 5,
      guidance: "pn",
      navConstant: 3.5,
      reload: 1,
    };
  if (ammoType === "missile-rocket")
    return {
      name: "Rocket",
      mass: roundMass("missile-rocket", B),
      thrust: 5400,
      fuel: 4,
      turnRate: 1,
      hp: 20,
      damage: nice(smart * B.ordnance.rocketWarheadShare),
      proximityFuse: 5,
      blastRadius: 4,
      guidance: "none",
      reload: B.ammo["missile-rocket"]!.interval / B.ammo["missile-smart"]!.interval,
    };
  return null;
}

/** Applies the formulas to one part. Numbers the model does not cover (ranges, rates, damage) are kept. */
export function derivePart(part: PartDef, B: Balance = BALANCE): PartDef {
  const p: PartDef = structuredClone(part);
  const V = partVolume(p, B);
  const f = p.balance ?? {};
  const out = f.output ?? 1;
  const cls = componentClass(p);
  p.mass = nice(B.density[cls] * V * (f.mass ?? 1));
  p.hp = nice(B.hp[cls] * V * (f.hp ?? 1));

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
    if (w.kind === "missile") {
      w.ammoType = "missile";
      w.internalMagazine = 0;
      w.powerPerShot = nice(loadEnergy(B.ordnance.refMissileMass, B));
      delete w.missile;
    } else if (w.projectile) {
      w.internalMagazine = internalRounds(w.fireInterval, f.internalShare ?? B.weapons.internalShare, B);
      w.heatPerShot = nice(shotHeat(w.projectile.mass, w.projectile.speed, B));
    } else if (w.beam) {
      w.heatWhileFiring = nice((w.powerDraw ?? 0) * B.heat.beamExtra);
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
