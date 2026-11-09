import type { Scenario } from "../schemas/scenario";
import { validateScenario } from "../validate";
import s01 from "./s01-first-flight.json";
import s02 from "./s02-fixed-or-turret.json";
import s03 from "./s03-armor.json";
import s04 from "./s04-heat.json";
import s05 from "./s05-power.json";
import s06 from "./s06-missiles.json";
import s07 from "./s07-drones.json";
import s08 from "./s08-mixed-fleet.json";
import s09 from "./s09-fleet-action.json";
import s10 from "./s10-missile-storm.json";
import s11 from "./s11-mirror-destroyers.json";
import s12 from "./s12-mirror-escort.json";
import s13 from "./s13-mirror-carriers.json";
import s14 from "./s14-mirror-battle-line.json";
import s15 from "./s15-mirror-rearguard.json";

/** The scenario list (spec §12), validated at load and sorted by `order`. */
export const SCENARIOS: readonly Scenario[] = [
  s01,
  s02,
  s03,
  s04,
  s05,
  s06,
  s07,
  s08,
  s09,
  s10,
  s11,
  s12,
  s13,
  s14,
  s15,
]
  .map((j) => {
    const r = validateScenario(j);
    if (!r.ok) throw new Error(`Invalid scenario:\n${r.errors.join("\n")}`);
    return r.value;
  })
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
