import type { PartDef } from "../../data/schemas/part";
import { fmt } from "./dom";

const kN = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)} kN` : `${n.toFixed(0)} N`);
const J = (j: number) => (j >= 1e6 ? `${(j / 1e6).toFixed(1)} MJ` : `${(j / 1e3).toFixed(0)} kJ`);

/**
 * Key numbers of a part for the palette's info box, as [label, value] rows. Covers what the player needs
 * to compare parts: mass, toughness, what it uses and what heat it makes.
 */
export function partInfoRows(d: PartDef): [string, string][] {
  const rows: [string, string][] = [
    ["Mass", fmt.mass(d.mass)],
    ["HP", String(d.hp)],
    ["Cost", String(d.cost)],
  ];
  if (d.armor) rows.push(["Armor", `−${d.armor} per hit`]);
  if (d.conducts === false) rows.push(["Networks", "does not conduct"]);
  if (d.command) {
    rows.push(["Gyro torque", `${kN(d.command.gyroTorque)}·m`]);
    rows.push(["Power draw", fmt.watts(d.command.powerDraw)]);
  }
  if (d.gyro) {
    rows.push(["Torque", `${kN(d.gyro.torque)}·m`]);
    rows.push(["Power draw", fmt.watts(d.gyro.powerDraw)]);
    if (d.gyro.heat) rows.push(["Heat", fmt.watts(d.gyro.heat)]);
  }
  if (d.engine) {
    rows.push(["Thrust", kN(d.engine.thrust)]);
    rows.push(["Gimbal", `±${d.engine.gimbalMax}°`]);
    rows.push(["Isp", `${d.engine.isp} s`]);
    if (d.engine.powerDraw) rows.push(["Power draw", fmt.watts(d.engine.powerDraw)]);
    rows.push(["Heat at full", fmt.watts(d.engine.heatAtMax)]);
  }
  if (d.thruster) {
    rows.push(["Thrust", kN(d.thruster.thrust)]);
    rows.push(["Isp", `${d.thruster.isp} s`]);
    rows.push(["Heat at full", fmt.watts(d.thruster.heatAtMax)]);
  }
  if (d.reactor) {
    rows.push(["Output", fmt.watts(d.reactor.maxOutput)]);
    rows.push(["Heat", `${Math.round(d.reactor.heatPerWatt * 100)} % of output`]);
  }
  if (d.battery) {
    rows.push(["Capacity", J(d.battery.capacity)]);
    rows.push(["Discharge", fmt.watts(d.battery.maxDischarge)]);
  }
  if (d.fuelTank) rows.push(["Fuel", fmt.mass(d.fuelTank.capacity)]);
  if (d.magazine) rows.push(["Ammo", `${d.magazine.capacity} × ${d.magazine.ammoType}`]);
  if (d.radiator) {
    rows.push(["Dissipation", `${fmt.watts(d.radiator.dissipation)} extended`]);
    rows.push(["Retracted", `${Math.round(d.radiator.retractedFactor * 100)} %`]);
  }
  if (d.heatSink) rows.push(["Heat capacity", `+${J(d.heatSink.capacity)}`]);
  const w = d.weapon;
  if (w) {
    rows.push(["Weapon", `${w.kind} · ${w.mount}`]);
    if (w.mount === "turret") {
      if (w.traverseRate !== undefined) rows.push(["Turn rate", `${w.traverseRate}°/s`]);
      if (w.arc) rows.push(["Arc", `${w.arc[0]}° … ${w.arc[1]}°`]);
    }
    if (w.projectile) rows.push(["Damage", `${w.projectile.damage} per round`]);
    if (w.beam) rows.push(["Damage", `${w.beam.dps} per second`]);
    if (w.missile) rows.push(["Damage", `${w.missile.damage} blast`]);
    rows.push(["Fire rate", `${(1 / w.fireInterval).toFixed(w.fireInterval < 1 ? 0 : 2)} /s`]);
    rows.push(["Range", `${w.range} m`]);
    if (w.ammoType) rows.push(["Ammo", w.ammoType]);
    if (w.powerDraw) rows.push(["Power draw", fmt.watts(w.powerDraw)]);
    const heat = (w.heatWhileFiring ?? 0) + (w.heatPerShot ?? 0) / w.fireInterval;
    if (heat > 0) rows.push(["Heat firing", fmt.watts(heat)]);
  }
  if (d.hangar) rows.push(["Hangar", `${d.hangar.capacity} × ${d.hangar.droneType}`]);
  return rows;
}

/** Lower-case text a palette search matches: name, id, category, weapon kind/mount and ammo type. */
export function partSearchText(d: PartDef): string {
  const w = d.weapon;
  return [d.name, d.id, d.category, w?.kind, w?.mount, w?.ammoType, d.magazine?.ammoType]
    .filter((x): x is string => !!x)
    .join(" ")
    .toLowerCase();
}

/** True when every whitespace-separated term of `query` occurs in the part's search text. */
export function matchesSearch(d: PartDef, query: string): boolean {
  const text = partSearchText(d);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => text.includes(t));
}
