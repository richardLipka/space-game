import type { ShipDesign } from "../schemas/design";
import { validateDesign } from "../validate";
import gunboat from "./demo-gunboat.json";
import fighter from "./demo-fighter.json";
import hauler from "./demo-hauler.json";
import frigate from "./demo-frigate.json";
import picket from "./demo-picket.json";
import gunCruiser from "./demo-cruiser-guns.json";
import missileFrigate from "./demo-frigate-missile.json";
import droneAttack from "./drone-attack.json";
import dronePd from "./drone-pd.json";
import droneDecoy from "./drone-decoy.json";
import archArmor from "./balance/arch-armor.json";
import archAutocannon from "./balance/arch-autocannon.json";
import archCannon from "./balance/arch-cannon.json";
import archCarrier from "./balance/arch-carrier.json";
import archHeavy from "./balance/arch-heavy.json";
import archLance from "./balance/arch-lance.json";
import archLaser from "./balance/arch-laser.json";
import archMissile from "./balance/arch-missile.json";
import fleetWasp from "./fleet/wasp.json";
import fleetSpark from "./fleet/spark.json";
import fleetMaul from "./fleet/maul.json";
import fleetNeedle from "./fleet/needle.json";
import fleetRapier from "./fleet/rapier.json";
import fleetViper from "./fleet/viper.json";
import fleetAnvil from "./fleet/anvil.json";
import fleetSquall from "./fleet/squall.json";
import fleetLeviathan from "./fleet/leviathan.json";
import fleetArk from "./fleet/ark.json";

function load(list: readonly unknown[]): ShipDesign[] {
  return list.map((j) => {
    const r = validateDesign(j);
    if (!r.ok) throw new Error(`Invalid bundled design:\n${r.errors.join("\n")}`);
    return r.value;
  });
}

/** Drone types the core hangars launch (spec §9.7). */
export const CORE_DRONES: readonly ShipDesign[] = load([droneAttack, dronePd, droneDecoy]);

/**
 * The symmetric fleet (two fighters, two gunboats, two destroyers, two cruisers, a battleship and a
 * carrier), ordered from smallest to largest.
 */
export const FLEET: readonly ShipDesign[] = load([
  fleetWasp,
  fleetSpark,
  fleetMaul,
  fleetNeedle,
  fleetRapier,
  fleetViper,
  fleetAnvil,
  fleetSquall,
  fleetLeviathan,
  fleetArk,
]);

/**
 * Every design shipped with the game (demo ships, drones, balance archetypes, the fleet), by id. Scenarios refer to
 * enemy and reference designs by these ids (spec §12).
 */
export const BUNDLED_DESIGNS: ReadonlyMap<string, ShipDesign> = new Map(
  [
    ...load([gunboat, fighter, hauler, frigate, picket, gunCruiser, missileFrigate]),
    ...CORE_DRONES,
    ...load([
      archArmor,
      archAutocannon,
      archCannon,
      archCarrier,
      archHeavy,
      archLance,
      archLaser,
      archMissile,
    ]),
    ...FLEET,
  ].map((d) => [d.id, d]),
);
