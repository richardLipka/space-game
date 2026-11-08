# Implementation Plan — 2D Space Combat Prototype

Companion to [space-game-spec.md](space-game-spec.md) (v0.3). Section references (§) point to the spec.

---

## 1. Guiding principles

1. **Simulation first, pixels second.** Each milestone builds the `/sim` logic headless with tests, then adds rendering and UI on top.
2. **Always playable.** Every milestone ends with something you can run in the browser and try.
3. **Determinism from day one.** A seeded RNG, a fixed timestep and a state-hash test exist before any gameplay code. Retrofitting them later is painful.
4. **Data before code.** New content is added by writing JSON, not by special-casing parts in code.
5. **Every milestone has exit criteria.** A milestone is done when its automated tests pass in CI *and* its manual acceptance checklist is ticked off.

---

## 2. Test strategy overview

| Layer | Tool | What it covers | Runs |
|---|---|---|---|
| **Unit** | Vitest | Pure functions: geometry, mass properties, allocator, power, heat, damage maths | Every commit |
| **Property-based** | fast-check (with Vitest) | Invariants over random inputs: mass conservation, snapping symmetry, hash stability | Every commit |
| **Sim integration** | Vitest + headless runner | Multi-system scenarios run for N ticks, checking the end state | Every commit |
| **Golden runs** | Headless runner | Fixed seed + recorded inputs → final state hash must match the stored value | Every commit |
| **Physics accuracy** | Vitest | Simulated results compared with analytic results (Tsiolkovsky, α = τ/I, ballistics) | Every commit |
| **E2E / UI** | Playwright | Editor flows, import/export, HUD, theme switching | Every PR |
| **Performance** | Vitest bench + headless runner | Tick time under load against the §13.5 budget | Nightly / per milestone |
| **Balance** | Headless runner | Design-vs-design win rates over N seeds | M7, then on demand |
| **Manual acceptance** | Checklist | Feel, readability, fun | End of each milestone |

**Shared test fixtures** (in `/test/fixtures`):
- `parts/` — a minimal test catalogue with simple shapes and round numbers, e.g. a 1×1 m square of 100 kg, so expected values are easy to calculate by hand.
- `designs/` — reference ships: `brick` (a single part), `dumbbell` (two masses on a beam), `asymmetric`, `rcs-only`, `main-only`, `cruiser-300`.
- `inputs/` — recorded `ControlIntent` streams used for golden runs.

**Golden-hash workflow:** `npm run golden:update` regenerates the stored hashes. Any change to a hash must be explained in the PR description. A hash that changes without explanation counts as a determinism bug.

---

## 3. Milestones

Relative size is given as T-shirt sizes (S/M/L/XL) for one developer.

```
M0 Foundation ─► M1 Physics core ─► M2 Editor ─► M3 Systems ─► M4 Combat ─► M5 Missiles/PD/Drones ─► M6 AI ─► M7 Scenarios & balance
                        └─────────────── theme layer and camera start in M1 and grow in every later milestone ───────────────┘
```

---

### M0 — Foundation (S)

**Goal:** the project skeleton, tooling and core sim infrastructure, before any gameplay.

**Tasks**
1. Vite + TypeScript (strict) project. Set up ESLint, Prettier, Vitest, Playwright and fast-check.
2. Create the folder structure from §13.2. Add a lint rule that **forbids importing DOM/render/ui/editor code into `/sim`**.
3. Add a lint rule that bans `Math.random` and `Date.now` inside `/sim`.
4. Core utilities: `Vec2` maths, a seeded RNG (e.g. xoshiro128**), a fixed-step loop with an accumulator and interpolation alpha, and a stable ID generator.
5. **State hashing:** canonical serialization of the sim state (sorted keys, floats rounded to fixed precision for hashing only), then SHA-256.
6. A headless runner CLI: `npm run sim -- --scenario x --seed 1 --ticks 6000 --inputs file`.
7. JSON schema validation for part definitions, designs and scenarios, using Ajv with schemas generated from the TS types.
8. CI (GitHub Actions): lint, type-check, unit tests, golden tests, and a Playwright smoke test.
9. Planck.js wrapper boundary: a thin adapter, so the rest of the sim never calls Planck directly.

**Tests**
| # | Test | Expectation |
|---|---|---|
| 0.1 | RNG: same seed → same sequence of 10k values | Identical |
| 0.2 | RNG: different seeds → different sequences | Different |
| 0.3 | Fixed-step loop: rendering at 30/60/144 FPS for 10 s gives the same number of sim ticks | 600 ticks ±1 |
| 0.4 | State hash is independent of object key insertion order (property-based) | Equal hashes |
| 0.5 | Schema: valid fixture files pass. Each kind of invalid file (missing field, wrong type, extra field) fails with a readable path | Pass / fail as listed |
| 0.6 | Lint: a file in `/sim` importing `pixi.js` or calling `Math.random` fails lint | Lint error |
| 0.7 | Headless runner: an empty world for 1000 ticks has the same hash on two runs | Equal |

**Exit criteria:** CI is green, and the runner and hash infrastructure work end to end.

---

### M1 — Physics core (L)

**Goal:** a hardcoded ship flies correctly using computed mass properties, gimballed main engines, RCS, gyro, stabilization and both speed-kill modes. It is drawn in neon wireframe through the CSS theme layer.

**Tasks**
1. **Polygon geometry:** area, centroid and second moment of area for convex polygons, and concave polygons as a union of convex pieces. Transforms.
2. **Mass properties** (§6.1): per-part mass (dry + fuel + ammo), ship CoM and inertia using the parallel-axis theorem. Push them to Planck with `setMassData`. Adjust the body position when the CoM shifts.
3. **ShipModel:** part instances, transforms and runtime state (hp, fuel, ammo). For now ships are built from code or fixture JSON. The editor arrives in M2.
4. **Forces:** main engines with gimbal through the CoM, cos φ loss, and shutdown outside the limit (§6.3). RCS thrusters at their mount positions. Gyro torque. Fuel flow $\dot m = T u / (I_{sp} g_0)$ from one global tank (networks come in M3).
5. **Thrust allocator** (§6.6): bounded least squares using projected gradient or NNLS with a fixed iteration count and fixed ordering. The gyro takes torque demand first.
6. **Flight controller:** `ControlIntent` → throttles. Rotational stabilization. Face-angle mode as a PD controller toward the target heading, limited by the turn capability.
7. **Speed kill:** X (keep orientation) and Shift+X (flip and burn), using the `referenceVelocity()` hook.
8. **Arena basics:** rectangular bounds with a soft boundary force. Static asteroids as collision bodies. Collision damage is only recorded at this stage.
9. **Gravity wells** (§6.9): force on bodies, with softening.
10. **Input:** keyboard and mouse → `ControlIntent`.
11. **Rendering:** a Pixi scene with interpolation, drawing parts as outlines.
12. **Theme layer (§13.7):** CSS probe elements, a style resolver with a cache, `neon.css` and a minimal `flat.css`. Theme switching at runtime.
13. **Camera (§10.1):** follow, follow + target, free. Zoom. Minimum-size class icons.
14. **Debug HUD:** velocity, angular velocity, fuel, throttles, a CoM marker and thrust vectors.

**Tests**
| # | Test | Expectation |
|---|---|---|
| 1.1 | Area and centroid of unit square, right triangle, regular hexagon | Analytic values within 1e-9 |
| 1.2 | Inertia of a uniform rectangle w×h of mass m about its centroid | $m(w^2+h^2)/12$ within 1e-9 |
| 1.3 | Inertia of a concave L-shape given as 2 convex pieces equals the inertia from triangle decomposition | Equal within 1e-9 |
| 1.4 | Ship CoM for the `dumbbell` fixture (two 100 kg parts at x = ±5) | (0, 0). Inertia = 2·(I_local + 100·25) |
| 1.5 | Property: rotating or translating a whole design doesn't change mass or inertia, and the CoM moves with it | Invariant |
| 1.6 | Property: total mass = sum of part masses for random designs | Exact |
| 1.7 | Main engine pointing exactly through the CoM: force = T·u, torque = 0 | Exact |
| 1.8 | Main engine at φ = 10° with a 15° limit: force = T·u·cos10°, torque = 0, fuel use based on T·u | Within 1e-9 |
| 1.9 | Main engine at φ = 20° with a 15° limit: force 0, flagged "out of gimbal" | Exact |
| 1.10 | CoM shifts (asymmetric fuel burn) push an engine past its limit → it shuts off at runtime | State flag set |
| 1.11 | RCS thruster at r = (0, 2) with force (1000, 0) → torque = −2000 N·m | Exact |
| 1.12 | Gyro only: angular acceleration = τ/I. Bang-bang 180° turn time ≈ $2\sqrt{\pi/\alpha}$ | Within 2% |
| 1.13 | Doubling ship length (I ×≈ 8 for a scaled beam) increases turn time as predicted | Within 5% |
| 1.14 | Allocator: pure forward intent on the `main-only` design → only the main engine fires, torque ≈ 0 | |
| 1.15 | Allocator: strafe intent on the `rcs-only` design → lateral force with net torque below 1% of maximum | |
| 1.16 | Allocator: impossible intent (strafe on `main-only`) → best effort, no NaN, throttles within [0, 1] | |
| 1.17 | Allocator determinism: same inputs → bit-identical outputs over 1000 random cases | |
| 1.18 | **Tsiolkovsky:** full burn of all fuel from rest gives Δv = $I_{sp} g_0 \ln(m_0/m_1)$ | Within 1% |
| 1.19 | Free drift: no input, no stabilization disturbance → velocity is constant over 10k ticks | Drift below 1e-6 |
| 1.20 | Stabilization: initial ω = 2 rad/s with no input → ω below 0.01 within the predicted time | |
| 1.21 | Speed kill (X) from 100 m/s on `main-only` facing retrograde → stops; time ≈ v/a_max ±10%; fuel used > 0 | |
| 1.22 | Speed kill (Shift+X) from 100 m/s facing prograde → rotates about 180°, then stops | Final speed < ε |
| 1.23 | Speed kill cancels on thrust input; flip-and-burn falls back to keep-orientation on rotation input | State transitions |
| 1.24 | `referenceVelocity()` returning a non-zero vector makes speed kill converge to that velocity | Hook works |
| 1.25 | Gravity: a body in a circular orbit stays within 1% radius drift over 5 orbits (with a small timestep check) | |
| 1.26 | Soft boundary: a ship at 50 m/s outward is turned back and never goes beyond the boundary + margin | |
| 1.27 | **Golden run:** `asymmetric` design with the recorded input stream for 6000 ticks | Hash matches |
| 1.28 | Theme: changing `--stroke` in a theme updates the resolved style; the sim state hash is unchanged | |
| 1.29 | Theme resolver cache: 10k lookups of the same selector cause one `getComputedStyle` call | |
| 1.30 | E2E: page loads, ship responds to W (velocity increases), theme switch changes canvas pixels | Playwright |

**Manual acceptance:** flying is controllable. Speed kill feels useful. The asymmetric ship visibly turns differently from the symmetric one. The neon look is readable, and zooming from fighter to cruiser scale works.

**Exit criteria:** all tests pass, the manual checklist is complete, and one tick takes under 0.5 ms for a single 50-part ship.

---

### M2 — Ship editor and sharing (XL)

**Goal:** build ships from polygon parts with edge snapping, validate them, inspect their stats, test-fly them, and save, export, import and share them.

**Tasks**
1. **Core catalogue v0** in JSON: the parts from §5, with placeholder numbers, edge types, content hashes and namespaced IDs.
2. **Editor geometry:**
   - snap-edge candidate search using a spatial index
   - snap transform: make the edges anti-parallel and collinear, then slide along the target edge
   - free rotation, Shift for 15° steps, Alt to disable snapping
   - overlap test (SAT with tolerance)
3. **Connection detection** (§3.3): collinearity, anti-parallel normals, overlap length ≥ minimum. Recomputed on load.
4. **Validation** (§3.4): all rules, with errors and warnings attached to specific parts.
5. **Exposure analysis:** uncovered length of `hull` and `function` edges. Exhaust clearance raycast.
6. **Turret self-occlusion:** precompute blocked angle ranges by casting rays from the muzzle.
7. **Editor UI:** palette, drag and drop, selection, delete, undo/redo (command pattern), mirror mode.
8. **Live stats panel and overlays** (§3.5). Acceleration per direction and turn time are computed by the same allocator used in flight.
9. **Weapon group assignment and power priority UI.** These are stored in the design; the systems that use them arrive in M3/M4.
10. **Test flight:** a sandbox arena with dummies, which goes back to the editor with the design unchanged.
11. **Local library** in IndexedDB: designs, user parts, imported parts, and "used by" lookups.
12. **Export/import (§4.5):**
    - canonical JSON and content hashes
    - dependency collection (parts, mirror variants, ammo types, drone designs, recursively)
    - file, clipboard and `SG1:` codes
    - import pipeline: schema → sanity limits → core resolution → user-part conflict rename → design-ID collision dialog → recompute
    - optional archival export

**Tests**
| # | Test | Expectation |
|---|---|---|
| 2.1 | Snap: dragging part B's edge within 0.3 m and 10° of A's free snap edge → B ends up exactly anti-parallel and collinear | Edge distance < 1e-6 |
| 2.2 | Snap is rejected when the target edge is `hull` or `function` | No snap |
| 2.3 | Connections: overlap 0.3 m with minOverlap 0.25 m → connected, with overlapLength = 0.3 | |
| 2.4 | Connections: overlap 0.2 m → not connected | |
| 2.5 | Connections: parallel edges 2 cm apart, or 1° off → not connected | |
| 2.6 | Property: connection detection is symmetric (A–B ⇔ B–A) and independent of part order | |
| 2.7 | Property: translating or rotating the whole design keeps the same connection set | |
| 2.8 | Overlap: two parts sharing an edge exactly → no overlap error; 1 cm overlap → error | |
| 2.9 | Validation: zero command modules / two command modules → error | |
| 2.10 | Validation: a disconnected island → error that names the island's parts | |
| 2.11 | Validation: a `hull` edge covered by a part → error | |
| 2.12 | Validation: a part blocking the engine's exhaust ray → error | |
| 2.13 | Validation: main engine outside gimbal reach → warning, not error | |
| 2.14 | Exposure: a radiator with half of its function edge covered → exposedFraction = 0.5 | ±1e-6 |
| 2.15 | Turret occlusion: a turret beside a tall block → blocked range matches the analytic angle | ±0.5° |
| 2.16 | Mirror mode: placing a part creates its mirror; the CoM of a symmetric design lies on the axis | |
| 2.17 | Undo/redo: 50 random edits, undo all → design equals the original (deep equal) | |
| 2.18 | Stats panel values equal the M1 sim values for the same design | Same functions |
| 2.19 | **Export round trip:** export → import → design deep-equals the original; connections and mass properties are identical | |
| 2.20 | Dependency collection: a design using 2 user parts + a hangar with a custom drone (which uses another user part) → the bundle contains exactly 3 parts + 1 drone design | Exact set |
| 2.21 | Core parts are referenced by hash, not embedded (unless archival export) | |
| 2.22 | Content hash is independent of key order and formatting (property-based) | Equal |
| 2.23 | Import: same user-part ID with the same hash → reused, not duplicated | |
| 2.24 | Import: same ID with a different hash → renamed `~2`, design references rewritten, local part unchanged | |
| 2.25 | Import: missing core part → rejected with a list of missing IDs | |
| 2.26 | Import: core hash mismatch → imported with a warning; "pin original" works with an archival bundle | |
| 2.27 | Import: out-of-range values (thrust 1e12, 10k vertices) → rejected with a list of fields; nothing written to the library | |
| 2.28 | Import: tampered `summary` values are ignored; recomputed values are used | |
| 2.29 | Import: newer `formatVersion` → rejected with a clear message | |
| 2.30 | `SG1:` code round trip equals the JSON round trip; a corrupted code → clean error, no crash | |
| 2.31 | Paste detection: raw JSON, `SG1:` code and junk text are each handled correctly | |
| 2.32 | E2E: build a valid 10-part ship from an empty canvas, save, reload the page, design still there | Playwright |
| 2.33 | E2E: export a file → import it in a fresh browser profile → identical stats | Playwright |
| 2.34 | E2E: drag-drop import and clipboard paste import | Playwright |
| 2.35 | Perf: snapping and validation for a 300-part cruiser stay under 8 ms per drag frame | Bench |

**Manual acceptance:** building feels smooth, snapping is predictable, overlays make the physics understandable, and sharing a code through a chat app works.

**Exit criteria:** tests pass. Three reference ships (fighter, frigate, cruiser) can be built in the editor and flown. Export and import work between two machines.

---

### M3 — Resource systems (L)

**Goal:** networks, power priorities, fuel, ammo and heat with radiators, all visible in the HUD.

**Tasks**
1. **Connection graph → networks** (§7.1): union-find or BFS over intact, conducting parts. A dirty flag triggers recomputation.
2. **Command link:** networks without the command module get control disabled; the PD exception is wired up when PD arrives in M5.
3. **Power allocation** (§7.2): supply (reactors follow demand, battery discharge) and demand grouped by priority, then fill groups in priority order and share proportionally in the first group that can't be fully served. Battery charging. `powerFactor` per consumer.
4. **Fuel per network:** draw proportionally from the tanks on the network. Engines with no fuel path don't fire.
5. **Ammo:** magazines on the network refill weapons' internal magazines (weapons fire in M4; a test-only consumer is used now).
6. **Heat** (§7.4): global pool, capacity from heat sinks, generation from all sources, radiator dissipation (exposure × extended/retracted × hpFactor), throttle band from 70% to 100%, overheat damage.
7. Radiator toggle (R). Power priority panel (P), adjustable live.
8. HUD: power bars per group, battery, fuel, heat gauge with thresholds. Overlay showing networks.
9. Mass-property updates from fuel and ammo use (the 0.5% threshold).
10. Temporary debug tool for M3 testing: "kill part" (click a part to destroy it).

**Tests**
| # | Test | Expectation |
|---|---|---|
| 3.1 | Networks: chain A–B–C, destroy B → 2 networks {A}, {C} | |
| 3.2 | Networks: a ring A–B–C–D–A, destroy B → still 1 network | |
| 3.3 | Property: the number of networks is never more than the number of intact parts; every intact part is in exactly one network | |
| 3.4 | Non-conducting part between two sections → they are separate networks | |
| 3.5 | Power: supply 100 W, demands propulsion 60 / weapons 60, priority propulsion > weapons → factors 1.0 / 0.667 | ±1e-9 |
| 3.6 | Power: same demands, reversed priority → weapons 1.0, propulsion 0.667 | |
| 3.7 | Power: three groups, supply covers only the first → the second gets the remainder proportionally, the third gets 0 | |
| 3.8 | Battery: surplus charges up to maxCharge and capacity; deficit discharges up to maxDischarge | |
| 3.9 | Battery empty + reactor destroyed → all powerFactors 0 except the gyro, which has no power either → ship can't rotate | Expected per spec |
| 3.10 | Reactor at hpFactor 0.5 → max output halved | |
| 3.11 | Cut-off network with its own reactor powers its own consumers but receives no commands | |
| 3.12 | Fuel: two tanks on the network drain proportionally; a tank on another network isn't touched | |
| 3.13 | Engine with no fuel path → thrust 0, HUD flag "no fuel path" | |
| 3.14 | Heat steady state: generation = dissipation → heat level stays constant (±0.1%) over 10k ticks | |
| 3.15 | Heat at 85% → heat producers throttled to 0.75 | ±1e-9 |
| 3.16 | Heat at 110% → heat-producing parts lose HP at the specified rate | |
| 3.17 | Radiator retracted → dissipation × retractedFactor; extended → ×1; damage taken × extendedDamageMult | |
| 3.18 | Radiator with exposedFraction 0.5 at hpFactor 0.5 → 25% dissipation | |
| 3.19 | Fuel use moves the CoM → mass properties recomputed once per 0.5% mass change | Number of recomputes |
| 3.20 | Golden run: frigate flying a power-starved input script | Hash matches |
| 3.21 | E2E: changing power priority in the HUD changes which group browns out | Playwright |

**Manual acceptance:** a player can understand from the HUD why something isn't working. Destroying a central conduit visibly cuts off a wing.

---

### M4 — Combat (XL)

**Goal:** fixed and turret weapons, groups and modes, projectiles, beams, per-part damage, armor, wrecks, defeat conditions. Two player-built ships can fight; the second ship is controlled by a dummy script until M6.

**Tasks**
1. **Weapon runtime:** cooldowns, internal magazine, power per shot, heat per shot, hpFactor effects on rate of fire and accuracy.
2. **Fixed mounts** with an auto-aim cone. **Turrets:** traverse at a set rate within the arc, respecting blocked ranges, with lead calculation.
3. **Weapon groups 1–9:** selection, Shift to add, modes hold/manual/AI (the AI mode is a stub that is completed in M5 with the shared targeting code), mouse aiming, LMB to fire.
4. **Projectiles:** entity pool, inherited velocity + muzzle velocity, seeded spread, swept raycast per tick, gravity, lifetime.
5. **Beams:** raycast each tick, damage per second with falloff, power drain and heat while firing.
6. **Damage pipeline:** hit → first fixture → armor reduction (`max(minDamage, hit − armor)`) → HP → wreck pass-through (50% absorbed, the rest continues along the ray to the next part) → destruction → network dirty → mass properties unchanged (wrecks keep their mass).
7. **Collision damage** from contact impulses.
8. Optional (Should priority): **exploding** fuel tanks, magazines and reactors with area damage.
9. **Defeat detection** (§8.1): command module destroyed OR (zero effective thrust AND no weapon able to fire). The defeated ship becomes a drifting wreck.
10. RMB target selection. Projectile impulses applied to the target.
11. Visual effects through theme selectors: muzzle flash, tracers, beam glow, hit sparks, wreck styling, explosions.

**Tests**
| # | Test | Expectation |
|---|---|---|
| 4.1 | Projectile velocity = shooter velocity + muzzle velocity × direction (spread set to 0) | Exact |
| 4.2 | **Anti-tunnelling:** a 3000 m/s projectile at a 0.5 m plate at 60 Hz → hits on every one of 1000 seeded runs | 100% |
| 4.3 | Projectile hits the *first* part along its path (an armor plate in front of a reactor) → only the armor takes damage | |
| 4.4 | Armor: hit 50, armor 20 → 30 damage; hit 10, armor 20, minDamage 2 → 2 | Exact |
| 4.5 | Wreck pass-through: hit 100 on a wreck in front of part X → X takes 50 (after X's own armor) | |
| 4.6 | Two wrecks in a row → 25 passes through | |
| 4.7 | Beam: dps 100 for 1 s → 100 damage (±1 tick); falloff beyond falloffStart matches the formula | |
| 4.8 | Beam: power drain while firing; at powerFactor < 1 the beam's damage scales down | |
| 4.9 | Fire interval: weapon with interval 0.5 s fires 20 shots in 10 s (±1) | |
| 4.10 | Internal magazine empties → refills from a magazine on the network at the reload rate; magazine on another network isn't used | |
| 4.11 | Turret: target at 90° with traverse 45°/s → aligned after 2 s (±1 tick) | |
| 4.12 | Turret never fires into a blocked range (property: random targets around the ship) | 0 self-hits |
| 4.13 | Turret: lead calculation against a constant-velocity target → hit rate > 95% with spread 0 | |
| 4.14 | Groups: only the selected manual groups fire on LMB; hold groups never fire; unselected manual groups don't fire | |
| 4.15 | hpFactor 0.5 on a weapon → reduced rate of fire and larger spread as specified | |
| 4.16 | Part destroyed → becomes a wreck, network split occurs, mass unchanged, still collides | |
| 4.17 | Defeat: destroy the command module → defeated | |
| 4.18 | Defeat: destroy all engines and thrusters AND empty all ammo, with the gyro intact → defeated | |
| 4.19 | Not defeated: engines gone but one weapon still able to fire → still active | |
| 4.20 | Collision: impulse below the threshold → 0 damage; above it → proportional damage to both contacting parts | |
| 4.21 | Projectile impulse changes the target's momentum by m_p·v_rel (±1%) | |
| 4.22 | Golden run: frigate vs. a scripted dummy frigate, recorded inputs, 3600 ticks | Hash matches |
| 4.23 | Perf: 500 active projectiles + 10 ships → tick under 4 ms | Bench |
| 4.24 | E2E: select group 2, aim, fire → the dummy's armor HP drops in the HUD | Playwright |

**Manual acceptance:** hits feel responsive, damage is readable (you can see which parts are hurt), and armor layering visibly matters.

---

### M5 — Missiles, point defense, drones (L)

**Goal:** guided missiles, automatic PD and flak, three fixed drone types with hangars, and the AI-mode turret stub completed.

**Tasks**
1. **Missiles:** point-mass entities with heading, thrust, fuel, turn-rate limit, proportional navigation and pursuit guidance, proximity fuse, blast with falloff (reduced behind wrecks), HP so they can be shot down, gravity.
2. Missile launchers (M key or weapon group), drawing from missile magazines.
3. **Shared targeting module:** threat list, time-to-impact ranking, intercept (lead) solution, arc and occlusion check.
4. **PD turrets:** always automatic, engage missiles and drones, optional toggle to engage ships. **Flak:** proximity-burst shells.
5. **Weapon group AI mode** = the targeting module against ships.
6. **Command-link exception:** PD in cut-off networks keeps working.
7. **Drones:** three fixed drone designs as `ShipDesign` JSON flagged as drones. Hangar storage, launch (H) at the launch interval, drone AI (attack: harass the target; PD: escort the mother ship; decoy: attract missiles and PD for a short lifetime).
8. Decoy preference in missile and PD target selection.
9. Should priority: drones return to the hangar to refuel and rearm.

**Tests**
| # | Test | Expectation |
|---|---|---|
| 5.1 | PN missile vs. a stationary target → hits on 100% of 100 seeded runs | |
| 5.2 | PN missile vs. a constant-velocity target crossing at 100 m/s → hit rate ≥ 95% | |
| 5.3 | PN missile vs. a target turning at maximum rate → hit rate within the expected band (documents the missile's limits) | Recorded baseline |
| 5.4 | Missile out of fuel → coasts ballistically; responds to gravity | |
| 5.5 | Proximity fuse fires at the configured distance; blast damage falls off as specified; parts behind wrecks take reduced damage | |
| 5.6 | Missile HP: one PD hit with damage ≥ HP destroys it | |
| 5.7 | Intercept solver: constant-velocity target → solution error < 0.1 m; no solution → returns none (no NaN) | |
| 5.8 | PD: a single missile from 2 km → intercepted before impact on ≥ 95% of seeded runs | |
| 5.9 | PD saturation: a 10-missile salvo vs. 1 PD turret → some get through (a baseline is recorded for balancing) | Baseline |
| 5.10 | Flak burst damages all missiles within the burst radius | |
| 5.11 | PD prioritizes the missile with the soonest impact over a nearer but slower one | |
| 5.12 | PD ignores ships unless the toggle is on; with the toggle on and no missiles, it fires at ships | |
| 5.13 | PD in a network cut off from command still fires; manual weapons in that network don't | |
| 5.14 | Decoy present → ≥ 70% of incoming missiles retarget to the decoy (seeded batch) | Baseline |
| 5.15 | Hangar: capacity 4, launch interval 1 s → 4 drones in about 3 s; a 5th launch is refused | |
| 5.16 | Drones use the same physics: a drone design's mass properties match M1 calculations | |
| 5.17 | Drone out of fuel → becomes inert | |
| 5.18 | Drone design files go through the same export and import (dependency test from 2.20 extended) | |
| 5.19 | Golden run: missile duel with PD on both sides | Hash matches |
| 5.20 | Perf: 40 missiles + 30 drones + 500 projectiles + 10 ships → tick under 8 ms | Bench |

**Manual acceptance:** missile salvos vs. PD are exciting and readable; drones are useful and not overpowered.

---

### M6 — AI (XL)

**Goal:** a generic combat AI that flies any design through the same control interface, with profiles, allied ships, Tab switching and orders.

**Tasks**
1. **Capabilities profile:** maximum acceleration per direction, turn time, Δv, weapon ranges, arcs and damage per second, fixed vs. turret share, heat and power headroom, missile and drone stock. Recomputed when the ship takes damage.
2. **Steering layer:** desired velocity and heading → `ControlIntent` (using the M1 flight controller). Obstacle and boundary avoidance.
3. **Utility behaviours** (§11.2): approach, hold range, orbit/broadside, face and attack, evade, retreat, cool down. Re-evaluated every 0.5 s with hysteresis.
4. **Fire control:** hit-probability threshold, missile volley timing, drone launch timing.
5. **Target selection:** threat ÷ distance, preferring weakened targets.
6. **AI profiles** as data (aggressive, kiter, brawler, sniper, carrier).
7. **Allies:** follow the player by default. Tab switches control, and the previous ship goes to AI. Ctrl-click selection. Orders J/K/L. Orders can be given while paused.
8. **Debug view:** current behaviour, utility scores, desired velocity vector.

**Tests**
| # | Test | Expectation |
|---|---|---|
| 6.1 | **Architecture:** AI code only produces `ControlIntent`s and weapon commands; it never applies forces directly | Lint/import-boundary test + review |
| 6.2 | Capability profile of `main-only` → forward acceleration > 0, lateral acceleration = 0; after destroying the engine → forward acceleration = 0 | |
| 6.3 | Approach: AI starting 5 km away settles at its preferred range ±15% within T seconds | |
| 6.4 | A fixed-weapon AI points its nose at the target within its aim cone ≥ 70% of the time while engaged | |
| 6.5 | A turret-heavy AI maintains broadside: mean number of turrets able to fire ≥ 80% of the maximum | |
| 6.6 | Evade: an incoming missile triggers evade behaviour within 0.5 s; decoys are launched if available | |
| 6.7 | Cool down: heat above 70% → beams stop firing until heat < 50% | |
| 6.8 | Retreat: hp < threshold or out of ammo → moves away from the threat | |
| 6.9 | Boundary and asteroid avoidance: 100 seeded runs in a dense asteroid field → collisions below threshold, no boundary exits | |
| 6.10 | **AI vs. dummy:** each reference design kills a non-moving dummy within T seconds on 100% of seeds | |
| 6.11 | **Mirror match:** identical designs → win rate 40–60% over 200 seeds (no side bias); battles end within the time limit ≥ 95% | |
| 6.12 | Profiles: a kiter keeps a longer average range than a brawler with the same design | Statistical |
| 6.13 | Tab switch: control moves to the new ship; the previous ship's AI resumes the same tick | |
| 6.14 | Orders: "attack my target" → ally targets it within 0.5 s; "hold" → ally speed-kills and stays within 100 m | |
| 6.15 | Determinism: AI-vs-AI battle has an identical hash on two runs | Golden |
| 6.16 | Perf: 10 AI ships → AI cost under 1 ms per tick on average | Bench |

**Manual acceptance:** AI ships look like they have intent. Different designs produce visibly different fighting styles. Allies are helpful, not a burden.

---

### M7 — Scenarios, polish, balance (L)

**Goal:** a complete playable prototype: scenario list, objectives, results, the asteroid arena, and a first balancing pass.

**Tasks**
1. Scenario loader (§4.4): arena, drifting asteroids, gravity wells (supported, used in at most one bonus scenario), spawns, objectives (destroyAll, survive, protect), fleet budget check.
2. Scenario select screen → editor with the budget → battle → results screen (win/lose, time, damage dealt and taken, parts lost) → back to the editor.
3. Results saved locally.
4. 6–10 handmade scenarios that teach mechanics in order: flight → fixed vs. turret → armor → heat → power → missiles and PD → drones → mixed fleet.
5. Handmade enemy designs (built in the editor, stored as JSON).
6. **Balance harness:** a matrix of design × design × N seeds producing win rate, time to kill and damage breakdown as CSV/HTML. First tuning pass of catalogue numbers.
7. Polish: audio hooks (optional), tutorial hints, settings (key bindings, theme selection), pause menu.
8. Scenario export with dependencies (§4.5).

**Tests**
| # | Test | Expectation |
|---|---|---|
| 7.1 | Every shipped scenario loads, validates and runs headless for 60 s without errors | All |
| 7.2 | Every shipped scenario can be won: a reference player design flown by AI wins ≥ 1 of 20 seeds | All |
| 7.3 | Objectives: destroyAll / survive T / protect X each produce correct win and loss events | |
| 7.4 | Budget: a fleet over budget can't start the scenario; at exactly the budget it can | |
| 7.5 | Drifting asteroids are deterministic (golden hash) | |
| 7.6 | Balance: no part appears in > 80% of the top-performing harness designs (avoid dominant parts) | Report |
| 7.7 | Balance: every weapon type wins against at least one counter-design and loses against at least one | Report |
| 7.8 | Scenario export → import in a fresh profile → plays identically (same seed → same hash) | |
| 7.9 | E2E: full loop — pick scenario → build → fight (scripted) → results → back to editor | Playwright |
| 7.10 | Perf: the largest scenario holds 60 Hz sim on the reference laptop; headless runs ≥ 20× real time | Bench |

**Manual acceptance:** a new player can finish scenarios 1–3 without explanation. Playtesters choose to iterate on their designs after losing.

**Exit criteria (prototype done):** all milestones' tests are green, the scenarios are completable, and the balance report has no glaring outliers.

---

## 4. Cross-cutting work (every milestone)

| Area | Ongoing work |
|---|---|
| Golden runs | Each milestone adds at least one golden scenario. Earlier ones must keep passing or have their hashes re-baselined with a justification |
| Theme | Every new visual element gets a semantic selector, and `flat.css` is updated so the theme-switch test stays meaningful |
| Data | New mechanics are added as part-definition fields and schema updates, never as part IDs hardcoded in logic |
| Export format | Any schema change bumps `formatVersion` or stays backward-compatible. A test imports bundles saved by every earlier milestone (fixtures in `/test/fixtures/bundles/vN`) |
| Perf | The nightly benchmark posts tick-time trends. A regression > 20% fails the nightly build |
| Docs | The spec is updated whenever a milestone changes a decision; the decision log (§14) stays current |

---

## 5. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Thrust allocator unstable or slow with many thrusters | Bad flight feel, high CPU cost | Fixed-iteration solver; cache the allocation matrix per configuration; fall back to grouped thrusters; benchmark in M1 |
| Planck.js float differences across browsers | Replays and multiplayer later | Determinism only promised per JS engine for now (§13.4); keep the Planck adapter so the engine can be swapped |
| Free-angle polygon snapping feels fiddly | The editor is frustrating | Prototype snapping UX early in M2 with playtesting; tune tolerances; add magnetic preview |
| Huge cruisers (300 parts) slow down the sim | Perf targets missed | Spatial index for hit tests; per-ship broad phase; part-count bench in M2 |
| Mixed scales are hard to read on screen | Confusing battles | Camera rules (§10.1) in M1; class icons; theme-driven minimum sizes |
| AI can't fly arbitrary player designs well | Weak opponents | Capability profile + utility AI tested against all reference designs; mirror-match tests |
| Balance spirals with heat × power × weapons | Dominant builds | Balance harness from M4 onward, not only M7 |
| Export format churn | Shared ships break | Versioned format and a fixture library of old bundles imported in CI |

---

## 6. Suggested order inside milestones

Each milestone follows the same rhythm:

1. **Data and schema** changes.
2. **Sim logic** with unit and property tests (headless).
3. **Integration tests and golden run.**
4. **Rendering and theme selectors.**
5. **UI/HUD** and Playwright tests.
6. **Manual acceptance session**, then fix and retag.
