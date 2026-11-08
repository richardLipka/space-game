import type { ShipDesign, PartPlacement } from "../schemas/design";

/**
 * Procedurally laid-out cruiser (~100 m, ~150 parts) for scale and camera testing until the editor exists.
 * Built only from core parts on a 2 m grid so snapping edges line up.
 */
export function makeCruiserDesign(): ShipDesign {
  const parts: PartPlacement[] = [];
  let n = 0;
  const add = (partId: string, x: number, y: number, angle = 0) =>
    parts.push({ uid: `c${String(++n).padStart(3, "0")}`, partId, x, y, angle });

  const len = 22; // hull plates along x (2 m each)
  for (let i = 0; i < len; i++) {
    const x = -len + 1 + i * 2;
    const halfWidth = i < 4 ? 2 : i > len - 4 ? len - i : 3;
    for (let j = -halfWidth; j <= halfWidth; j++) {
      // Smaller parts sit flush against the neighbouring cell's edge so they connect.
      // 1.5 m parts sit on the top edge of the cell below (y = −1).
      if (i === 11 && j === 0) add("core:command.s", x, -0.25);
      else if ((i === 9 || i === 10) && j === 0) add("core:reactor.s", x, -0.25);
      else if (j === 0 && i > 2 && i < 8) add("core:tank.fuel.m", x, 0);
      else if (Math.abs(j) === 1 && i > 4 && i < 9) {
        add("core:gyro.s", x - 0.5, j * 2 - 0.5);
        add("core:gyro.s", x - 0.5, j * 2 + 0.5);
      } else add("core:hull.square.m", x, j * 2);
    }
  }
  // Engines at the stern, nozzles facing −x.
  for (const y of [-3, 0, 3]) add("core:engine.main.l", -len - 1, y);
  // Nose.
  add("core:hull.wedge.m", len + 1, 0);
  // RCS clusters at bow and stern.
  for (const [x, y, a] of [
    [len - 5, 7.25, 180],
    [len - 5, -7.25, 0],
    [-len + 3, 5.25, 180],
    [-len + 3, -5.25, 0],
    [len - 3, 5.25, 180],
    [len - 3, -5.25, 0],
  ] as const) {
    add("core:rcs.s", x, y, a);
  }
  // Radiator panels on both flanks, standing on their short attach edges so both faces radiate.
  for (const x of [-7, 1, 9]) for (const y of [8, -8]) add("core:radiator.s", x, y, 90);
  return {
    formatVersion: 1,
    id: "demo-cruiser",
    name: "Bastion (generated cruiser)",
    createdAt: "2026-11-08T00:00:00Z",
    modifiedAt: "2026-11-08T00:00:00Z",
    parts,
    weaponGroupModes: {},
    powerPriority: ["gyro", "propulsion", "weapons", "pointDefense", "hangar"],
  };
}
