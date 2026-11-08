import type { ShipDesign } from "../data/schemas/design";
import type { PartCatalogue } from "../sim/ship/catalogue";
import { exhaustBlockedBy, type LayoutIndex } from "../sim/ship/layout";
import { buildPropulsion } from "../sim/flight/propulsion";
import { computeMassProps, instantiateParts } from "../sim/ship/ship";
import { layoutOf } from "./placement";

export type Severity = "error" | "warning";

export interface Issue {
  readonly severity: Severity;
  readonly code:
    | "command-count"
    | "disconnected"
    | "overlap"
    | "covered-edge"
    | "over-budget"
    | "exhaust-blocked"
    | "out-of-gimbal"
    | "no-fuel-source"
    | "no-power-source"
    | "no-ammo-source"
    | "no-propulsion"
    | "no-weapons";
  readonly message: string;
  /** Part uids the issue is attached to (for highlighting). */
  readonly parts: readonly string[];
}

export interface ValidateOptions {
  readonly budget?: number;
}

export interface ValidationReport {
  readonly issues: readonly Issue[];
  readonly errors: number;
  readonly warnings: number;
  readonly valid: boolean;
}

/** Connected components of the structural connection graph, largest first. */
export function components(design: ShipDesign, layout: LayoutIndex): string[][] {
  const adj = new Map<string, string[]>(design.parts.map((p) => [p.uid, []]));
  for (const c of layout.connections()) {
    adj.get(c.a)!.push(c.b);
    adj.get(c.b)!.push(c.a);
  }
  const seen = new Set<string>();
  const comps: string[][] = [];
  for (const p of design.parts) {
    if (seen.has(p.uid)) continue;
    const comp: string[] = [];
    const stack = [p.uid];
    seen.add(p.uid);
    while (stack.length) {
      const u = stack.pop()!;
      comp.push(u);
      for (const v of adj.get(u)!) {
        if (seen.has(v)) continue;
        seen.add(v);
        stack.push(v);
      }
    }
    comps.push(comp.sort());
  }
  return comps.sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1));
}

/** Design validation rules (spec §3.4). */
export function validateDesignLayout(
  design: ShipDesign,
  catalogue: PartCatalogue,
  options: ValidateOptions = {},
  layout: LayoutIndex = layoutOf(design, catalogue),
): ValidationReport {
  const issues: Issue[] = [];
  if (design.parts.length === 0) {
    issues.push({
      severity: "error",
      code: "command-count",
      message: "Ship needs a command module.",
      parts: [],
    });
    return { issues, errors: 1, warnings: 0, valid: false };
  }
  const defs = new Map(design.parts.map((p) => [p.uid, catalogue.get(p.partId).def]));
  const uidsWhere = (pred: (d: ReturnType<typeof defs.get> & object) => boolean) =>
    design.parts.filter((p) => pred(defs.get(p.uid)!)).map((p) => p.uid);

  const commands = uidsWhere((d) => !!d.command);
  if (commands.length !== 1) {
    issues.push({
      severity: "error",
      code: "command-count",
      message:
        commands.length === 0
          ? "Ship needs a command module."
          : `Ship has ${commands.length} command modules; exactly one is allowed.`,
      parts: commands,
    });
  }

  const comps = components(design, layout);
  for (const island of comps.slice(1)) {
    issues.push({
      severity: "error",
      code: "disconnected",
      message: `${island.length} part(s) are not connected to the main structure.`,
      parts: island,
    });
  }

  for (const [a, b] of layout.overlaps()) {
    issues.push({
      severity: "error",
      code: "overlap",
      message: `Parts ${a} and ${b} overlap.`,
      parts: [a, b],
    });
  }

  for (const p of design.parts) {
    for (const e of layout.edges.get(p.uid)!) {
      if (e.type === "snap") continue;
      if (layout.coveredLength(p.uid, e.index) > 1e-3) {
        issues.push({
          severity: "error",
          code: "covered-edge",
          message: `${defs.get(p.uid)!.name}: ${e.type === "hull" ? "outer hull" : "functional"} edge ${e.index} is covered.`,
          parts: [p.uid],
        });
      }
    }
  }

  const cost = design.parts.reduce((s, p) => s + defs.get(p.uid)!.cost, 0);
  if (options.budget !== undefined && cost > options.budget) {
    issues.push({
      severity: "error",
      code: "over-budget",
      message: `Cost ${cost} exceeds budget ${options.budget}.`,
      parts: [],
    });
  }

  for (const placed of layout.parts) {
    const blocker = exhaustBlockedBy(layout, placed);
    if (blocker) {
      issues.push({
        severity: "error",
        code: "exhaust-blocked",
        message: `${placed.def.def.name}: exhaust path is blocked by ${blocker}.`,
        parts: [placed.uid, blocker],
      });
    }
  }

  // Gimbal reach and propulsion (same functions as the flight model).
  const parts = instantiateParts(design, catalogue);
  const mp = computeMassProps(parts);
  const prop = buildPropulsion(parts, mp, true);
  for (const e of prop.engines) {
    if (e.outOfGimbal) {
      issues.push({
        severity: "warning",
        code: "out-of-gimbal",
        message: `Main engine ${e.partUid} cannot gimbal to the centre of mass (${((e.phi * 180) / Math.PI).toFixed(1)}°).`,
        parts: [e.partUid],
      });
    }
  }

  // Resource sources (per connected structure; networks proper arrive in M3).
  const main = new Set(comps[0] ?? []);
  const inMain = (uid: string) => main.has(uid);
  const engines = uidsWhere((d) => !!d.engine || !!d.thruster);
  const tanks = uidsWhere((d) => !!d.fuelTank).filter(inMain);
  if (engines.length > 0 && tanks.length === 0) {
    issues.push({
      severity: "warning",
      code: "no-fuel-source",
      message: "Engines have no connected fuel tank.",
      parts: engines,
    });
  }
  const powered = design.parts.filter((p) => {
    const d = defs.get(p.uid)!;
    return (
      (d.engine?.powerDraw ?? 0) +
        (d.thruster?.powerDraw ?? 0) +
        (d.gyro?.powerDraw ?? 0) +
        (d.command?.powerDraw ?? 0) +
        (d.weapon?.powerDraw ?? 0) +
        (d.weapon?.powerPerShot ?? 0) >
      0
    );
  });
  const sources = uidsWhere((d) => !!d.reactor || !!d.battery).filter(inMain);
  if (powered.length > 0 && sources.length === 0) {
    issues.push({
      severity: "warning",
      code: "no-power-source",
      message: "Powered parts have no connected reactor or battery.",
      parts: powered.map((p) => p.uid),
    });
  }
  const magazines = new Set(
    design.parts
      .filter((p) => inMain(p.uid))
      .map((p) => defs.get(p.uid)!.magazine?.ammoType)
      .filter(Boolean),
  );
  for (const p of design.parts) {
    const ammo = defs.get(p.uid)!.weapon?.ammoType;
    if (ammo && !magazines.has(ammo)) {
      issues.push({
        severity: "warning",
        code: "no-ammo-source",
        message: `${defs.get(p.uid)!.name} has no connected ${ammo} magazine.`,
        parts: [p.uid],
      });
    }
  }
  if (engines.length === 0)
    issues.push({
      severity: "warning",
      code: "no-propulsion",
      message: "Ship has no engines or thrusters.",
      parts: [],
    });
  if (!design.parts.some((p) => defs.get(p.uid)!.weapon))
    issues.push({ severity: "warning", code: "no-weapons", message: "Ship has no weapons.", parts: [] });

  const errors = issues.filter((i) => i.severity === "error").length;
  return { issues, errors, warnings: issues.length - errors, valid: errors === 0 };
}
