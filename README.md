# Space Game (prototype)

2D tactical space combat where the ship's physical construction decides how it flies, fights and fails.
Design docs: [docs/space-game-spec.md](docs/space-game-spec.md) and [docs/implementation-plan.md](docs/implementation-plan.md).

## Status

| Milestone               | State                                                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 Foundation           | Done: tooling, deterministic sim core, schemas, headless runner, golden runs, CI                                                                                                                                                                      |
| M1 Physics core         | Done: mass properties, gimballed engines, RCS, gyro, allocator, speed kill, gravity, arena, neon/flat themes, camera, HUD                                                                                                                             |
| M2 Editor and sharing   | Done: polygon editor with edge snapping, mirror mode, validation, live stats, overlays, undo/redo, local library (IndexedDB), self-contained export/import (file, JSON, `SG1:` codes), test flight                                                    |
| M3 Resource systems     | Done: resource networks over connected parts, power priorities and brownout, per-network fuel and ammo, heat pool with radiators and overheat damage, HUD and live priority panel                                                                     |
| M4 Combat               | Done: fixed and turret weapons, groups and modes, projectiles with swept hits, beams, armor, wrecks, explosions, collision damage, defeat, combat HUD and effects                                                                                     |
| Playtest 1 fixes        | Done: speed kill turns and burns when there is no retro thrust, damped recoil, per-turret turn rate shown in part info, palette search and collapsible categories, HUD ammo and heat breakdown, hull radiation, glowing radiators, ejecting parts (B) |
| M5 Missiles, PD, drones | Next                                                                                                                                                                                                                                                  |

## Commands

```bash
npm install
npm run dev          # http://localhost:5173: ship editor (Sandbox / Test flight buttons open the flight view)
npm run check        # lint + format check + typecheck + unit/integration/golden/perf tests
npm run test:e2e     # Playwright (first time: npx playwright install chromium)
npm run sim -- --scenario test/fixtures/scenarios/asteroid-field.json --ticks 6000
npm run golden:update  # re-baseline golden hashes (explain every change in the PR)
```

## Controls

**Editor:** search the palette or open a category, hover a part for its numbers, click it, then click to place (stays in placing mode; Esc/right-click stops) ·
green edges = where the part can connect; the status line says what will connect ·
G connection graph (what power, fuel and ammo flow where) · Q/E rotate (Shift: 15° steps) · Alt: place without snapping · drag to move · Del delete · M mirror ·
1–9 weapon group (0 clears) · Ctrl+Z/Ctrl+Y undo/redo · Ctrl+S save · F fit view · wheel zoom · middle-drag pan ·
paste or drop a ship file / `SG1:` code anywhere to import

**Flight:**

W/S thrust · A/D strafe · Q/E rotate · F face cursor · X speed kill (turns to burn if it must) · Shift+X flip and burn ·
Tab switch ship · C camera mode · wheel zoom · middle-drag pan (free camera) · +/− time scale ·
Space pause · T theme · V overlays · H help · Esc back to editor ·
P power priority panel · R radiators in/out · N show resource networks · hold K + click: destroy a part (debug) ·
LMB fire selected groups at the cursor · 1–9 select weapon group (Shift adds) · G cycle group mode (manual/hold/AI) · RMB target a ship ·
B eject mode (click a part to jettison it and everything hanging on it; B/Esc leaves) · Shift+B jettison all wrecks

## Layout

- `src/sim` — pure, deterministic simulation (lint forbids DOM, rendering, wall-clock time, `Math.random`)
- `src/data` — JSON schemas (TypeBox + Ajv), core catalogue, designs, scenarios; `share/` export bundles, import, library
- `src/editor` — pure editor logic: snapping, validation, mirror, stats, undo, model
- `src/render` — PixiJS renderer, CSS theme resolver, camera
- `src/ui` — input, HUD, flight screen, editor screen and dialogs
- `src/themes` — theme stylesheets (`neon.css`, `flat.css`)
- `test/` — Vitest suites, fixtures, golden hashes; `e2e/` — Playwright
