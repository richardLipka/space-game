import type { ShipDesign } from "../data/schemas/design";
import type { PowerGroup } from "../data/schemas/design";
import type { PartCatalogue } from "../sim/ship/catalogue";
import type { LayoutIndex } from "../sim/ship/layout";
import { buildPropulsion, capabilities, G0 } from "../sim/flight/propulsion";
import { FLIGHT } from "../sim/flight/controller";
import { HEAT, hullDissipation } from "../sim/systems/heat";
import { computeMassProps, instantiateParts } from "../sim/ship/ship";
import { aabbOf } from "../sim/core/geometry";
import type { Vec2 } from "../sim/core/vec2";
import { layoutOf } from "./placement";

export type ShipClass = "drone" | "fighter" | "frigate" | "cruiser";

export interface DesignStats {
  readonly partCount: number;
  readonly cost: number;
  readonly mass: number;
  readonly center: Vec2;
  readonly inertia: number;
  /** Max acceleration per local direction (m/s²). */
  readonly accel: {
    readonly fwd: number;
    readonly back: number;
    readonly left: number;
    readonly right: number;
  };
  /** Max angular acceleration (rad/s²), using the weaker turning direction. */
  readonly alpha: number;
  /** Time-optimal 180° turn with the angular-speed cap (s). */
  readonly turn180: number;
  readonly fuel: { readonly capacity: number; readonly deltaV: number };
  readonly power: {
    readonly production: number;
    readonly battery: number;
    readonly demand: Record<PowerGroup, number>;
  };
  /** Heat at full use (W): generation vs. dissipation (radiators extended + hull radiation). */
  readonly heat: {
    readonly generation: number;
    readonly dissipation: number;
    readonly radiators: number;
    readonly hull: number;
    readonly capacity: number;
  };
  readonly ammo: Record<string, number>;
  /** Longest extent (m) and derived class (spec §2.1). */
  readonly length: number;
  readonly shipClass: ShipClass;
}

export const BASE_HEAT_CAPACITY = HEAT.baseCapacity;

export function shipClassFor(length: number): ShipClass {
  return length < 5 ? "drone" : length < 15 ? "fighter" : length < 60 ? "frigate" : "cruiser";
}

export function turnTime(angle: number, alpha: number, maxOmega: number = FLIGHT.maxOmega): number {
  if (!(alpha > 0)) return Infinity;
  return angle > (maxOmega * maxOmega) / alpha
    ? angle / maxOmega + maxOmega / alpha
    : 2 * Math.sqrt(angle / alpha);
}

/** Live stats for the editor panel (spec §3.5). Uses the same functions as the flight model (plan test 2.18). */
export function designStats(
  design: ShipDesign,
  catalogue: PartCatalogue,
  layout: LayoutIndex = layoutOf(design, catalogue),
): DesignStats {
  const parts = instantiateParts(design, catalogue);
  const mp = computeMassProps(parts);
  const caps = capabilities(buildPropulsion(parts, mp, true).actuators);
  const defs = parts.map((p) => p.def.def);

  let fuelCap = 0,
    thrustSum = 0,
    flowSum = 0;
  let production = 0,
    battery = 0,
    heatGen = 0,
    heatSink = 0,
    dissipation = 0;
  const demand: Record<PowerGroup, number> = {
    propulsion: 0,
    gyro: 0,
    weapons: 0,
    pointDefense: 0,
    hangar: 0,
  };
  const ammo: Record<string, number> = {};
  parts.forEach((p) => {
    const d = p.def.def;
    fuelCap += d.fuelTank?.capacity ?? 0;
    if (d.engine) {
      thrustSum += d.engine.thrust;
      flowSum += d.engine.thrust / (d.engine.isp * G0);
      demand.propulsion += d.engine.powerDraw;
      heatGen += d.engine.heatAtMax;
    }
    if (d.thruster) {
      demand.propulsion += d.thruster.powerDraw;
      heatGen += d.thruster.heatAtMax;
    }
    demand.gyro += (d.gyro?.powerDraw ?? 0) + (d.command?.powerDraw ?? 0);
    heatGen += d.gyro?.heat ?? 0;
    if (d.reactor) {
      production += d.reactor.maxOutput;
      heatGen += d.reactor.maxOutput * d.reactor.heatPerWatt;
    }
    battery += d.battery?.capacity ?? 0;
    heatSink += d.heatSink?.capacity ?? 0;
    if (d.radiator) {
      let len = 0,
        exposed = 0;
      for (const e of layout.edges.get(p.uid)!) {
        if (e.type !== "function") continue;
        len += e.length;
        exposed += e.length * layout.exposedFraction(p.uid, e.index);
      }
      dissipation += d.radiator.dissipation * (len > 0 ? exposed / len : 0);
    }
    if (d.magazine) ammo[d.magazine.ammoType] = (ammo[d.magazine.ammoType] ?? 0) + d.magazine.capacity;
    const w = d.weapon;
    if (w) {
      const draw = (w.powerDraw ?? 0) + (w.powerPerShot ?? 0) / w.fireInterval;
      if (w.kind === "pd") demand.pointDefense += draw;
      else demand.weapons += draw;
      heatGen += (w.heatWhileFiring ?? 0) + (w.heatPerShot ?? 0) / w.fireInterval;
    }
  });

  const isp = flowSum > 0 ? thrustSum / (flowSum * G0) : 0;
  const deltaV = fuelCap > 0 && isp > 0 ? isp * G0 * Math.log(mp.mass / (mp.mass - fuelCap)) : 0;
  const alpha = Math.min(caps.torqueCcw, caps.torqueCw) / mp.inertia;
  const box = aabbOf([...layout.outlines.values()].flat());
  const length = Math.max(box.maxX - box.minX, box.maxY - box.minY);
  void defs;
  const hull = hullDissipation(layout.exposedHullLength());
  return {
    partCount: parts.length,
    cost: design.parts.reduce((s, pl) => s + catalogue.get(pl.partId).def.cost, 0),
    mass: mp.mass,
    center: mp.center,
    inertia: mp.inertia,
    accel: {
      fwd: caps.fwd / mp.mass,
      back: caps.back / mp.mass,
      left: caps.left / mp.mass,
      right: caps.right / mp.mass,
    },
    alpha,
    turn180: turnTime(Math.PI, alpha),
    fuel: { capacity: fuelCap, deltaV },
    power: { production, battery, demand },
    heat: {
      generation: heatGen,
      dissipation: dissipation + hull,
      radiators: dissipation,
      hull,
      capacity: BASE_HEAT_CAPACITY + heatSink,
    },
    ammo,
    length,
    shipClass: shipClassFor(length),
  };
}
