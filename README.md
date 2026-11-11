# Space Game (prototype)

2D tactical space combat where the ship's physical construction decides how it flies, fights and fails.

**Play in the browser: https://richardlipka.github.io/space-game/** (updated automatically after CI passes on `main`; designs and results are saved in your browser).

Design docs: [docs/space-game-spec.md](docs/space-game-spec.md) and [docs/implementation-plan.md](docs/implementation-plan.md).

## Status

| Milestone                | State                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 Foundation            | Done: tooling, deterministic sim core, schemas, headless runner, golden runs, CI                                                                                                                                                                      |
| M1 Physics core          | Done: mass properties, gimballed engines, RCS, gyro, allocator, speed kill, gravity, arena, neon/flat themes, camera, HUD                                                                                                                             |
| M2 Editor and sharing    | Done: polygon editor with edge snapping, mirror mode, validation, live stats, overlays, undo/redo, local library (IndexedDB), self-contained export/import (file, JSON, `SG1:` codes), test flight                                                    |
| M3 Resource systems      | Done: resource networks over connected parts, power priorities and brownout, per-network fuel and ammo, heat pool with radiators and overheat damage, HUD and live priority panel                                                                     |
| M4 Combat                | Done: fixed and turret weapons, groups and modes, projectiles with swept hits, beams, armor, wrecks, explosions, collision damage, defeat, combat HUD and effects                                                                                     |
| Playtest 1 fixes         | Done: speed kill turns and burns when there is no retro thrust, damped recoil, per-turret turn rate shown in part info, palette search and collapsible categories, HUD ammo and heat breakdown, hull radiation, glowing radiators, ejecting parts (B) |
| M5 Missiles, PD, drones  | Done: guided missiles (proportional navigation, proximity fuse, blast, can be shot down), automatic PD and flak, shared targeting, AI-mode weapons, three drone types with hangars, decoys                                                            |
| M6 AI                    | Done: capability profile, steering with asteroid and boundary avoidance, utility behaviours, fire control, target selection, six AI profiles, allies with Tab hand-off and J/K/L orders, Skirmish mode                                                |
| M7 Scenarios and balance | In progress: balance harness and tuning pass ([balance-pass-1.md](docs/balance-pass-1.md)), eight scenarios with objectives, budget, scenario select and results screen; polish (settings, pause menu, scenario export) next                          |

## Commands

```bash
npm install
npm run dev          # http://localhost:5173: ship editor (Sandbox / Test flight buttons open the flight view)
npm run check        # lint + format check + typecheck + unit/integration/golden/perf tests
npm run test:e2e     # Playwright (first time: npx playwright install chromium)
npm run sim -- --scenario test/fixtures/scenarios/asteroid-field.json --ticks 6000
npm run golden:update  # re-baseline golden hashes (explain every change in the PR)
npm run balance -- --seeds 8   # balance matrix of the weapon archetypes → balance-report/report.html
npm run balance:scenarios      # every scenario AI vs AI with its suggested fleet → fight lengths, end reasons
npm run tune                   # automated tuning toward 1–5 min fights → balance-report/tune (add --apply to write it)
npm run ai:study               # AI types against each other on the mirror scenarios, parameter sweeps → balance-report/ai-study
```

## Ships

Besides the demo ships, the library is seeded with a symmetric fleet (`src/data/designs/fleet/`). Costs use catalogue v0-7.

| Class      | Ship      | Cost | Role                                                                                   |
| ---------- | --------- | ---- | -------------------------------------------------------------------------------------- |
| Fighter    | Wasp      | 150  | Two light autocannon turrets                                                           |
| Fighter    | Spark     | 254  | Two laser turrets, own reactor and radiators                                           |
| Gunboat    | Maul      | 498  | Forward heavy cannon, forward missile pair, PD                                         |
| Gunboat    | Needle    | 584  | Forward laser lance (three reactors, radiators), forward missile pair, PD              |
| Destroyer  | Rapier    | 901  | Kinetic: bow heavy turret, two forward cannons, autocannons, PD, heat sinks            |
| Destroyer  | Viper     | 984  | Four forward launchers, four laser turrets, radiators, PD                              |
| Cruiser    | Anvil     | 1521 | Forward kinetic fire: three heavy turrets, two fixed cannons, autocannons, PD          |
| Cruiser    | Squall    | 1391 | Missile broadsides (eight launchers), PD and flak                                      |
| Battleship | Leviathan | 3235 | Broadsides of eight heavy turrets and twelve launchers, radiator fins between them, PD |
| Carrier    | Ark       | 1701 | Attack, PD and decoy drone hangars on both flanks, PD and flak                         |

## Controls

**Scenarios:** Scenarios (toolbar) → choose one → add designs to the fleet (or take the suggested fleet) within the budget → Start battle → results → back to the editor. **Watch AI battle** lets the AI fly the fleet (or the suggested one) while you watch: Tab follows the next ship, +/− change the time scale up to ×8. Scenarios 11–15 are mirror matches: the same fleet on both sides, the enemy flown by a mix of AI types.

**Skirmish:** Skirmish (toolbar) → two sides, any designs, and a pilot per ship: you (side 1) or an AI type, aggressive, defensive (guards a ship you pick), retreating or cautious, each with 3–5 tunable parameters ([docs/ai-types.md](docs/ai-types.md)). Without a player ship you watch the battle.

**Editor:** search the palette or open a category, hover a part for its numbers, click it, then click to place (stays in placing mode; Esc/right-click stops) ·
green edges = where the part can connect; the status line says what will connect ·
G connection graph (what power, fuel and ammo flow where) · Q/E rotate (Shift: 15° steps) · Alt: place without snapping · drag to move (parts hanging on it come along; Ctrl+drag moves it alone) · Del delete · M mirror ·
1–9 weapon group (0 clears; the side panel creates groups and sets mode, fire range and target priority) · Ctrl+Z/Ctrl+Y undo/redo · Ctrl+S save · F fit view · wheel zoom · middle-drag pan ·
paste or drop a ship file / `SG1:` code anywhere to import

**Flight:**

W/S thrust · A/D strafe · Q/E rotate · F face cursor · X speed kill (turns to burn if it must) · Shift+X flip and burn ·
Tab switch ship · C camera mode · wheel zoom · middle-drag pan (free camera) · +/− or [ ] time scale (every flight starts at ×1; numpad +/− work too) ·
Space pause · T theme · V overlays · ? help · Esc back to editor ·
P power priority panel · R radiators in/out · N show resource networks · hold Y + click: destroy a part (debug) ·
LMB fire selected groups at the cursor · 1–9 select weapon group (the keys above the letters on any keyboard layout, or the numpad; Shift adds) · G cycle group mode (manual/hold/AI) · RMB target a ship ·
M launch a missile (Shift+M salvo) · H launch a drone (Shift+H all); each launcher and hangar is listed on the right with its reload · O PD also fires at ships ·
J allies follow · K allies attack my target · L allies hold · Ctrl+click select allies (Ctrl+Shift adds) ·
B eject mode (click a part to jettison it and everything hanging on it; B/Esc leaves) · Shift+B jettison all wrecks

**Flight models:** pick one in the editor toolbar (test flights and the sandbox) or in the skirmish setup; scenarios always use Newtonian.

- **Newtonian** (default): thrust adds speed and nothing takes it away; engines and thrusters are allocated to give the force and turn you ask for. You brake by burning the other way (X).
- **Arcade:** hold W and the ship flies, up to its top speed; let go and it stops. Turning turns where it flies, A/D still strafe (60 % of top speed), S reverses (50 %). Top speed and the time to reach it come from the ship: heavier ships are slower and take longer, more engine thrust helps both, and losing engines slows the ship down. For example a 2 t Wasp does about 225 m/s, a 16 t Rapier 140 m/s and the 49 t Leviathan 83 m/s. AI ships fly by the same rules; drones and missiles keep Newtonian flight.

**Cockpit:** the flight screen is laid out as a ship's control system around the edge of the view; the camera frames the action in the free centre.

- **Top:** scenario and objective, clock and time scale, a heading tape (the green marker is where the ship is actually moving), and blinking alerts (overheating, incoming missiles, no fuel, parts cut off).
- **Left:** helm instruments (speed, the thrust delivered right now, fuel with burn rate and time left, heat with what makes and sheds it, power and battery) and a plan of your ship with every part coloured by its hit points. Point at a part for its state.
- **Right:** the same plan for your target with range and closing speed; the contacts list; ordnance (each missile launcher and hangar with its reload, missiles and drones out, point defense).
- **Bottom:** fire control, one card per weapon group with its mode (click it to change), fire range, aim priority, weapons and reloads, then the magazines.
- **Contacts:** every ship with direction, distance and hull. Click a hostile to target it; ★ makes it the fleet's priority target. Click a friendly ship to pick it for orders, or use its FOL / ATK / HLD / GRD buttons. The fleet buttons order everyone: Help me (attack whoever is attacking you), Protect me, Follow, Attack tgt, Hold, Free. While watching a battle, a click follows that ship.

## Layout

- `src/sim` — pure, deterministic simulation (lint forbids DOM, rendering, wall-clock time, `Math.random`)
- `src/data` — JSON schemas (TypeBox + Ajv), core catalogue, designs, scenarios; `share/` export bundles, import, library
- `src/editor` — pure editor logic: snapping, validation, mirror, stats, undo, model
- `src/render` — PixiJS renderer, CSS theme resolver, camera
- `src/ui` — input, HUD, flight screen, editor screen and dialogs
- `src/themes` — theme stylesheets (`neon.css`, `flat.css`)
- `test/` — Vitest suites, fixtures, golden hashes; `e2e/` — Playwright
