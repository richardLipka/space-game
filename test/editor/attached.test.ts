import { describe, expect, it } from "vitest";
import coreJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import type { ShipDesign } from "../../src/data/schemas/design";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { attachedTo } from "../../src/editor/attached";
import { layoutOf } from "../../src/editor/placement";
import { EditorModel } from "../../src/editor/model";

const r = validateCatalogue(coreJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const core = PartCatalogue.fromJson(r.value);
const NOW = "2026-11-09T00:00:00Z";

/** Command module with a chain to the right (a → b → c) and a plate below. */
const ship: ShipDesign = {
  formatVersion: 1,
  id: "t",
  name: "t",
  createdAt: NOW,
  modifiedAt: NOW,
  weaponGroupModes: {},
  powerPriority: ["gyro", "propulsion", "weapons", "pointDefense", "hangar"],
  parts: [
    { uid: "cmd", partId: "core:command.s", x: 0, y: 0, angle: 0 },
    { uid: "a", partId: "core:hull.square.s", x: 1.25, y: 0, angle: 0 },
    { uid: "b", partId: "core:hull.square.s", x: 2.25, y: 0, angle: 0 },
    { uid: "c", partId: "core:hull.square.s", x: 3.25, y: 0, angle: 0 },
    { uid: "d", partId: "core:hull.square.s", x: 0, y: -1.25, angle: 0 },
  ],
};

describe("editor: moving a part carries what hangs on it", () => {
  it("attachedTo follows the jettison rule: parts that reach the command module only through the part", () => {
    const layout = layoutOf(ship, core);
    expect(attachedTo(ship, layout, "a")).toEqual(["b", "c"]);
    expect(attachedTo(ship, layout, "b")).toEqual(["c"]);
    expect(attachedTo(ship, layout, "c")).toEqual([]);
    expect(attachedTo(ship, layout, "d")).toEqual([]);
    expect(attachedTo(ship, layout, "cmd")).toEqual([]); // the command module moves alone
  });

  it("dragging carries the attached parts rigidly (translation and rotation), as one undo step", () => {
    const m = new EditorModel(core, ship, () => NOW);
    const carry = attachedTo(m.design, m.layout, "a");
    m.beginDrag();
    m.dragTo("a", 1.25, 2, Math.PI / 2, carry); // up 2 m and turned 90°
    m.endDrag();
    const at = (uid: string) => m.design.parts.find((p) => p.uid === uid)!;
    expect(at("a")).toMatchObject({ x: 1.25, y: 2, angle: 90 });
    // b was 1 m to the right of a; after a 90° turn about a it sits 1 m above it.
    expect(at("b").x).toBeCloseTo(1.25, 6);
    expect(at("b").y).toBeCloseTo(3, 6);
    expect(at("b").angle).toBe(90);
    expect(at("c").y).toBeCloseTo(4, 6);
    expect(at("d")).toMatchObject({ x: 0, y: -1.25 }); // not attached through a: stays
    expect(at("cmd")).toMatchObject({ x: 0, y: 0 });
    m.undo();
    expect(m.design.parts.find((p) => p.uid === "c")).toMatchObject({ x: 3.25, y: 0, angle: 0 });
  });

  it("without carry (Ctrl+drag) only the part moves", () => {
    const m = new EditorModel(core, ship, () => NOW);
    m.beginDrag();
    m.dragTo("a", 1.25, 2, 0);
    m.endDrag();
    expect(m.design.parts.find((p) => p.uid === "b")).toMatchObject({ x: 2.25, y: 0 });
  });
});
