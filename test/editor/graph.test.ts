import { describe, expect, it } from "vitest";
import type { ShipDesign } from "../../src/data/schemas/design";
import { connectionGraph } from "../../src/editor/graph";
import { layoutOf } from "../../src/editor/placement";
import { design, testCatalogue } from "../helpers";

const cat = testCatalogue();

function graphOf(parts: [string, number, number, number?][]) {
  const d: ShipDesign = {
    ...design("brick"),
    id: "g",
    parts: parts.map(([partId, x, y, angle], i) => ({ uid: `p${i + 1}`, partId, x, y, angle: angle ?? 0 })),
  };
  return connectionGraph(layoutOf(d, cat));
}
const edge = (g: ReturnType<typeof connectionGraph>, a: string, b: string) =>
  g.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));

describe("connection graph", () => {
  it("has a node per part and an edge per connection", () => {
    const g = graphOf([
      ["core:test.command", 0, 0],
      ["core:test.square", 1, 0],
      ["core:test.square", 2, 0],
    ]);
    expect(g.nodes.map((n) => n.uid)).toEqual(["p1", "p2", "p3"]);
    expect(g.nodes[1]!.position).toEqual({ x: 1, y: 0 });
    expect(g.edges.map((e) => `${e.a}-${e.b}`)).toEqual(["p1-p2", "p2-p3"]);
    expect(g.edges.every((e) => e.flows.length === 0)).toBe(true);
    expect(g.unsupplied).toEqual([]);
  });

  it("routes fuel from the tank through the chain to the engine, and nowhere else", () => {
    const g = graphOf([
      ["core:test.command", 0, 0],
      ["core:test.engine", -1, 0],
      ["core:test.square", 1, 0],
      ["core:test.fueltank", 2, 0],
      ["core:test.square", 0, 1],
    ]);
    expect(edge(g, "p3", "p4")!.flows).toEqual(["fuel"]);
    expect(edge(g, "p1", "p3")!.flows).toEqual(["fuel"]);
    expect(edge(g, "p1", "p2")!.flows).toEqual(["fuel"]);
    expect(edge(g, "p1", "p5")!.flows).toEqual([]); // side branch carries nothing
  });

  it("routes power and ammo separately, each from its own sources", () => {
    const g = graphOf([
      ["core:test.command", 0, 0],
      ["core:test.reactor", 1, 0],
      ["core:test.load.weapons", 2, 0],
      ["core:test.magazine", 0, 1],
      ["core:test.gun", 0, 2],
    ]);
    expect(edge(g, "p2", "p3")!.flows).toEqual(["power"]);
    expect(edge(g, "p1", "p2")!.flows).toEqual([]);
    expect(edge(g, "p4", "p5")!.flows).toEqual(["ammo"]);
    expect(edge(g, "p1", "p4")!.flows).toEqual([]);
  });

  it("an edge can carry several resources at once", () => {
    const g = graphOf([
      ["core:test.command", 0, 0],
      ["core:test.reactor", 1, 0],
      ["core:test.fueltank", 2, 0],
      ["core:test.square", 0, 1],
      ["core:test.gyro.powered", 0, 2],
      ["core:test.engine", -1, 2],
    ]);
    // Reactor and tank both feed the far end through the command module and the plate.
    expect(edge(g, "p1", "p4")!.flows).toEqual(["power", "fuel"]);
    expect(edge(g, "p2", "p3")!.flows).toEqual(["fuel"]);
  });

  it("feeds each consumer from the nearest source (fewest connections)", () => {
    const g = graphOf([
      ["core:test.fueltank", -1, 0],
      ["core:test.command", 0, 0],
      ["core:test.square", 1, 0],
      ["core:test.square", 2, 0],
      ["core:test.fueltank", 3, 0],
      ["core:test.engine", 2, -1, 0],
    ]);
    // The engine hangs under p4: the right-hand tank (1 hop) feeds it, the left tank's chain stays idle.
    expect(edge(g, "p4", "p5")!.flows).toEqual(["fuel"]);
    expect(edge(g, "p4", "p6")!.flows).toEqual(["fuel"]);
    expect(edge(g, "p1", "p2")!.flows).toEqual([]);
  });

  it("nothing crosses a non-conducting part; consumers behind it are reported unsupplied", () => {
    const g = graphOf([
      ["core:test.command", 0, 0],
      ["core:test.fueltank", 1, 0],
      ["core:test.insulator", 0, 1],
      ["core:test.engine", 0, 2],
      ["core:test.gun", -1, 0],
    ]);
    expect(edge(g, "p1", "p3")!.conducts).toBe(false);
    expect(edge(g, "p3", "p4")!.conducts).toBe(false);
    expect(edge(g, "p3", "p4")!.flows).toEqual([]);
    expect(g.nodes.find((n) => n.uid === "p3")!.conducts).toBe(false);
    expect(g.unsupplied).toEqual([
      { uid: "p4", resource: "fuel", detail: "no fuel tank connected" },
      { uid: "p5", resource: "ammo", detail: "no test-ammo magazine connected" },
    ]);
  });
});
