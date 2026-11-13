import { capabilities } from "../flight/propulsion";
import { deltaV, effectiveIsp, weaponDps } from "../../data/balance/model";
import { hpFactor } from "../ship/ship";
import type { Ship } from "../ship/ship-entity";

/**
 * What a ship can do right now (spec §11.1), read by the AI. Computed from the live ship, so damage,
 * fuel, ammo, power and heat are always reflected.
 */
export interface CapabilityProfile {
  /** Achievable acceleration per ship axis (m/s²). */
  readonly accel: {
    readonly fwd: number;
    readonly back: number;
    readonly left: number;
    readonly right: number;
  };
  /** Weaker of the two angular accelerations (rad/s²) and the time for a 180° turn from rest (s). */
  readonly alpha: number;
  readonly turnTime180: number;
  /** Velocity change left in the tanks at full thrust (m/s). */
  readonly deltaV: number;
  readonly weapons: {
    /** Damage per second of usable guns and beams, split by mount (missiles and PD excluded). */
    readonly fixedDps: number;
    readonly turretDps: number;
    readonly beamDps: number;
    /** DPS-weighted reach of usable guns (m), and the longest reach. */
    readonly bestRange: number;
    readonly maxRange: number;
    /** Share of gun DPS on fixed mounts (0..1). */
    readonly fixedShare: number;
    /** Muzzle speed of the main fixed gun (m/s), for leading; 0 for beams or none. */
    readonly fixedSpeed: number;
    /** Usable guns and beams: DPS, reach (m) and spread (rad), for range planning. */
    readonly guns: readonly {
      readonly dps: number;
      readonly reach: number;
      readonly spread: number;
      readonly fixed: boolean;
    }[];
  };
  /** Launchers aboard, launchers holding a round, launchers ready to fire now, missiles left, range. */
  readonly missiles: {
    readonly launchers: number;
    readonly loaded: number;
    readonly ready: number;
    readonly stock: number;
    readonly range: number;
  };
  readonly drones: { readonly stored: number; readonly decoys: number };
  /** Heat level (fraction of capacity), spare power (0..1), hull, gun ammo and fuel fractions. */
  readonly heat: number;
  readonly powerHeadroom: number;
  readonly hp: number;
  readonly ammo: number;
  readonly fuel: number;
  /** Rough combat value for target selection: DPS plus missile and drone stock. */
  readonly threat: number;
}

export function capabilityProfile(ship: Ship): CapabilityProfile {
  const prop = ship.propulsionNow();
  const caps = capabilities(prop.actuators);
  const m = ship.massProps.mass;
  const alpha = Math.min(caps.torqueCcw, caps.torqueCw) / ship.massProps.inertia;
  const turnTime180 = alpha > 0 ? 2 * Math.sqrt(Math.PI / alpha) : Infinity;

  let thrust = 0;
  let flow = 0;
  for (const a of prop.actuators) {
    if (a.fuelFlow <= 0) continue;
    thrust += Math.hypot(a.fx, a.fy);
    flow += a.fuelFlow;
  }
  const isp = effectiveIsp(thrust, flow);
  const fuel = ship.totalFuel;
  const dv = deltaV(isp, m, fuel);

  const guns: { dps: number; reach: number; spread: number; fixed: boolean }[] = [];
  let fixedDps = 0;
  let turretDps = 0;
  let beamDps = 0;
  let rangeSum = 0;
  let maxRange = 0;
  let fixedSpeed = 0;
  let fixedBest = 0;
  let ammoGuns = 0;
  let ammoReady = 0;
  let launchers = 0;
  let ready = 0;
  let loaded = 0;
  let missileRange = 0;
  const stockOf = (type: string) =>
    ship.parts.reduce(
      (n, p) => n + (p.hp > 0 && p.def.def.magazine?.ammoType === type ? Math.floor(p.ammo) : 0),
      0,
    );
  for (const w of ship.weapons) {
    const p = w.part;
    if (p.hp <= 0 || !ship.isCommanded(p.uid)) continue;
    const d = w.def;
    if (d.kind === "pd") continue;
    if (d.kind === "missile") {
      launchers++;
      // Missiles live in magazines: a launcher "holds a round" while its magazines do.
      const has = ship.nextMissile(p.uid) !== null;
      if (has) loaded++;
      if (has && w.cooldown <= 1e-9) ready++;
      missileRange = Math.max(missileRange, d.range);
      continue;
    }
    const usesAmmo = !!d.ammoType && d.internalMagazine > 0;
    let dps = 0;
    let reach = d.range;
    if (d.kind === "beam" && d.beam) {
      dps = weaponDps(d) * (ship.power.supply > 0 ? 1 : 0);
      beamDps += dps;
    } else if (d.projectile) {
      reach = Math.min(d.range, d.projectile.speed * d.projectile.lifetime);
      const has = !usesAmmo || p.ammo >= 1 || stockOf(d.ammoType!) > 0;
      if (usesAmmo) {
        ammoGuns++;
        if (has) ammoReady++;
      }
      dps = has ? weaponDps(d) * Math.max(0.25, hpFactor(p)) : 0;
    }
    if (dps <= 0) continue;
    if (d.mount === "fixed") {
      fixedDps += dps;
      if (dps > fixedBest) {
        fixedBest = dps;
        fixedSpeed = d.projectile?.speed ?? 0;
      }
    } else turretDps += dps;
    rangeSum += dps * reach;
    guns.push({
      dps,
      reach,
      spread: d.kind === "beam" ? 0 : (d.spread * Math.PI) / 180 / Math.max(0.25, hpFactor(p)),
      fixed: d.mount === "fixed",
    });
    maxRange = Math.max(maxRange, reach);
  }
  const gunDps = fixedDps + turretDps;
  const missileStock = launchers > 0 ? ship.missileStock().reduce((n, s) => n + s.count, 0) : 0;
  let stored = 0;
  let decoys = 0;
  for (const p of ship.parts) {
    const h = p.def.def.hangar;
    if (!h || p.hp <= 0) continue;
    stored += Math.floor(p.ammo);
    if (h.droneType.includes("decoy")) decoys += Math.floor(p.ammo);
  }
  const maxHp = ship.parts.reduce((s, p) => s + p.def.def.hp, 0);
  const pw = ship.power;
  return {
    accel: { fwd: caps.fwd / m, back: caps.back / m, left: caps.left / m, right: caps.right / m },
    alpha,
    turnTime180,
    deltaV: dv,
    weapons: {
      fixedDps,
      turretDps,
      beamDps,
      bestRange: gunDps > 0 ? rangeSum / gunDps : 0,
      maxRange,
      fixedShare: gunDps > 0 ? fixedDps / gunDps : 0,
      fixedSpeed,
      guns,
    },
    missiles: { launchers, loaded, ready, stock: missileStock, range: missileRange },
    drones: { stored, decoys },
    heat: ship.heatLevel,
    powerHeadroom: pw.supply > 0 ? Math.max(0, 1 - pw.used / pw.supply) : 0,
    hp: maxHp > 0 ? Math.min(1, ship.parts.reduce((s, p) => s + Math.max(0, p.hp), 0) / maxHp) : 0,
    ammo: ammoGuns > 0 ? ammoReady / ammoGuns : 1,
    fuel: ship.fuelCapacity > 0 ? fuel / ship.fuelCapacity : 0,
    threat: gunDps + missileStock * 40 + stored * 25,
  };
}
