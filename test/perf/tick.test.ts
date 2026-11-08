import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { makeCruiserDesign } from "../../src/data/designs/generate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import type { ShipDesign } from "../../src/data/schemas/design";
import { World } from "../../src/sim/world";
import { vec2 } from "../../src/sim/core/vec2";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);

/** First N parts of the generated cruiser plus its engines: a realistic ~50-part ship. */
function shipWithParts(n: number): ShipDesign {
  const c = makeCruiserDesign();
  const engines = c.parts.filter(
    (p) => p.partId.startsWith("core:engine") || p.partId.startsWith("core:command"),
  );
  const rest = c.parts.filter((p) => !engines.includes(p)).slice(0, n - engines.length);
  return { ...c, id: `perf-${n}`, parts: [...engines, ...rest] };
}

function msPerTick(design: ShipDesign, ticks: number): number {
  const w = new World({ seed: 1 });
  const ship = w.addShip(design, cat);
  w.setIntent(ship.id, { thrust: vec2(1, 0.3), rotate: 0.2 });
  w.run(200); // warm-up (JIT)
  const t0 = performance.now();
  w.run(ticks);
  return (performance.now() - t0) / ticks;
}

describe("M1 performance", () => {
  it("one tick of a single 50-part ship takes < 0.5 ms", () => {
    const d = shipWithParts(50);
    expect(d.parts).toHaveLength(50);
    const ms = msPerTick(d, 2000);
    console.log(`50-part ship: ${ms.toFixed(3)} ms/tick`);
    expect(ms).toBeLessThan(0.5);
  });

  it("150-part cruiser stays well inside the 16 ms frame", () => {
    const ms = msPerTick(makeCruiserDesign(), 1000);
    console.log(`150-part cruiser: ${ms.toFixed(3)} ms/tick`);
    expect(ms).toBeLessThan(2);
  });
});
