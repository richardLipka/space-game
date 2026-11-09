# 2D Space Combat Game — Prototype Specification

Version 0.3 · 2026-11-07

---

## 1. Vision and scope

A **tactical 2D space combat game** in which the ship's physical construction decides how it flies, fights and fails. Players build ships from predefined polygon parts in an editor, then fight scenario battles. They pilot one ship directly while allied ships fly under AI.

**Prototype goal:** prove that the core loop (design → fight → learn → redesign) is fun.

| In scope (prototype) | Out of scope (later) |
|---|---|
| Polygon ship editor with edge snapping | Ships splitting into separate bodies |
| Newtonian physics with CoM, inertia, gimbal, gyro | Repairs |
| Fuel, power and heat with network connectivity | Sensors, EW, stealth (perfect information for now) |
| Per-part damage, armor, inert wrecks | Custom drone designs |
| Projectiles, beams, missiles, point defense, drones | Full AI turret control (stubbed only) |
| Generic combat AI flying handmade enemy designs | AI-designed ships |
| Scenario list with point budgets | Campaign, unlocks, economy |
| Gravity wells (implemented, not in default scenarios) | Multiplayer (but the sim is kept deterministic) |
| Single-player, browser | Target-relative speed kill (but the hook exists) |
| Neon wireframe look, themeable via CSS | Textured or sprite art |
| Mixed ship classes, from drones to cruisers | |
| Basic orders for allied ships | Full RTS fleet control |
| Self-contained JSON export and import of ships and fleets, plus share strings | In-game part editor (but the format already carries custom parts) |

### Core loop
1. Pick a scenario. It defines the budget, the enemies, the arena and the objective.
2. Build or edit ships in the editor, inside the budget.
3. Test-fly them in a sandbox (optional).
4. Fight: pilot one ship while allies use AI, and switch ships at any time.
5. Win or lose, then go back to the editor and iterate.

---

## 2. Units and conventions

- SI units internally: metres, kilograms, seconds, newtons, joules, watts. Angles are in radians internally and degrees in the UI and data files.
- Each part has its own local frame. A ship has a local frame with its origin at the design origin. Mass properties are always computed relative to the CoM at runtime.
- Positive rotation is counter-clockwise.
- The simulation runs at a fixed **60 Hz** tick. Rendering interpolates between ticks.

### 2.1 Scale and ship classes
**Mixed classes** fight in the same battle. The class is derived from the design's bounding radius and is used for UI, AI profiles and scenario design. Class does not change any physics.

| Class | Typical size | Typical parts | Notes |
|---|---|---|---|
| Drone | 1–4 m | 3–8 | Hangar-launched only |
| Fighter | 5–15 m | 5–20 | Fast, fragile |
| Frigate | 15–60 m | 20–80 | The workhorse class |
| Cruiser | 60–300 m | 80–300 | Slow to turn. Parts come in larger sizes |

- Parts come in size tiers from about 1 m to 20 m. Large ships use large parts so their part count stays manageable.
- Weapon ranges run from about 200 m (PD) to about 3000 m (heavy cannons and missiles). Arenas are 5–20 km across.
- Balance between classes comes from the point budget and from physics. Big ships turn slowly and are easy to hit. Small ships are fragile and carry little ammo.

---

## 3. Ship construction

### 3.1 Parts are predefined polygons
- Every part is a predefined polygon from the catalogue (Section 5). Players do not draw shapes.
- Collision shapes must be convex. A concave part is defined as a list of convex pieces that share one outline.
- Every outline edge has an **edge type**:

| Edge type | Meaning |
|---|---|
| `snap` | Can connect to another part's `snap` edge |
| `hull` | Outer hull edge. Nothing may attach here, and it must stay exposed |
| `function` | A functional exposed edge, such as an engine nozzle, a radiator surface or a weapon muzzle face. Must be exposed. Nothing may attach |

### 3.2 Placement and rotation
- Parts can be placed at **any angle**, with no grid.
- **Snapping:** while dragging, if one of the part's `snap` edges comes within the snap distance (e.g. 0.3 m) and angle tolerance (e.g. 10°) of a free `snap` edge on the ship, the part rotates so the two edges are anti-parallel and collinear, then slides along the target edge.
  - Holding **Alt** disables snapping.
  - Holding **Shift** quantizes rotation to 15° steps when the part is not snapped.
- **Mirror mode:** an optional symmetry axis through the ship origin. Placing a part also places its mirrored twin (mirrored parts use the catalogue's mirrored variant where one exists).
  - *Implementation:* the axis is the ship's x axis, so (x, y) → (x, −y). A part placed at angle a is mirrored at −a − 2β, where β is a local reflection axis of the part (0°, 90°, 45° or 135°) about which its outline, edge types and functional directions (thrust, muzzle, mount axis) are all symmetric. Parts without such an axis use their `mirrorOf` variant. Moving or deleting a part in mirror mode does the same to its twin. A part placed on the axis gets no twin.
- Parts may not overlap. The polygon intersection test allows a tolerance of about 1 mm along shared edges.

### 3.3 Connections
Two parts are **connected** when one `snap` edge of each:
- is collinear with the other (angle within 0.5°, distance within 1 cm),
- faces the opposite way (anti-parallel normals),
- and overlaps the other by at least `minOverlap` (e.g. 0.25 m). **Partial overlap is allowed**, so staggered layouts work.

Each connection stores its `overlapLength`. Strength is proportional to that length. The prototype does not use strength, but it is kept for future structural failure and splitting.

Connections are recomputed from geometry whenever a design is loaded, so they cannot drift out of sync with the saved positions.

### 3.4 Design validation
| Rule | Severity |
|---|---|
| Exactly one command module | Error |
| All parts form a single connected graph | Error |
| No overlapping parts | Error |
| `hull` and `function` edges are not covered by another part | Error |
| Total cost ≤ scenario budget | Error (allowed in sandbox) |
| Engine exhaust path is clear of the ship's own parts (raycast from the nozzle) | Error |
| Main engine cannot gimbal to the CoM (Section 6.3) | Warning |
| A part has no network path to the resource it needs (power, fuel, ammo) | Warning |
| No propulsion or no weapons | Warning |

### 3.5 Editor features
- Part palette by category, with drag-and-drop, rotate and delete. Undo and redo.
- **Live stats panel:** mass, CoM, moment of inertia, cost and budget, maximum acceleration in each local direction (forward, back, left, right), maximum angular acceleration and turn time for 180°, power balance (production vs. demand per group), steady-state heat balance, fuel endurance at full thrust (Δv), and ammo counts.
- **Overlays** you can toggle:
  - CoM marker
  - thrust vectors and gimbal feasibility (green/red)
  - turret arcs, including the parts of the arc blocked by the ship itself
  - resource networks, coloured
  - exposed edges
  - connection overlap lines
- Weapon setup: assign weapons to **groups 1–9** and set each group's default mode.
- Power setup: the default **priority order** of power groups.
- **Test flight:** opens the design in an empty sandbox arena with target dummies.
- Save designs to the local library. Export and import them as self-contained JSON files, through the clipboard, or as share strings (Section 4.5).

---

## 4. Data model

All content is data-driven JSON and is validated against a schema on load.

- The TypeScript interfaces below describe the in-memory model. In JSON files a 2D vector is written as a compact `[x, y]` tuple, and angles are in degrees.
- Schemas are written with TypeBox (`src/data/schemas`), so the TS types and JSON Schemas come from one source.
- Recorded input streams (`InputStream`) hold persistent thrust, rotate and face-angle values from each frame's tick onward. `speedKill` (`keep` / `flip` / `cancel`) is a one-shot event on that tick.

### 4.1 Part definition (catalogue)
```ts
interface PartDef {
  id: string;                    // namespaced: "core:engine.main.m", "user:7f3a9c/engine.ion"
  rev: number;                   // bumped on every edit
  source: "core" | "user";
  author?: string;
  name: string;
  category: "structure" | "armor" | "command" | "propulsion" | "power"
          | "thermal" | "storage" | "weapon" | "hangar";
  outline: Vec2[];               // local, CCW
  convexPieces?: Vec2[][];       // if the outline is concave
  edges: EdgeType[];             // per outline edge: "snap" | "hull" | "function"
  mirrorOf?: string;
  mass: number;                  // kg, dry
  hp: number;
  cost: number;                  // budget points
  armor?: number;                // flat damage reduction per hit (armor parts)
  conducts: boolean;             // carries power/fuel/ammo through it (default true)

  // Optional functional blocks; a part may have several
  command?:   { gyroTorque: number; powerDraw: number };
  gyro?:      { torque: number; powerDraw: number; heat: number };
  engine?:    { thrust: number; isp: number; gimbalMax: number /*deg*/;
                nozzleEdge: number; powerDraw: number; heatAtMax: number };
  thruster?:  { thrust: number; isp: number; direction: Vec2 /*local*/;
                powerDraw: number; heatAtMax: number };
  reactor?:   { maxOutput: number /*W*/; heatPerWatt: number; minOutput?: number };
  battery?:   { capacity: number /*J*/; maxCharge: number; maxDischarge: number };
  fuelTank?:  { capacity: number /*kg*/ };
  magazine?:  { ammoType: string; capacity: number; massPerRound: number };
  radiator?:  { dissipation: number /*W, fully exposed & extended*/;
                retractedFactor: number; extendedDamageMult: number };
  heatSink?:  { capacity: number /*J added to ship heat capacity*/ };
  weapon?:    WeaponDef;
  hangar?:    { droneType: string; capacity: number; launchInterval: number };
}
```

### 4.2 Weapon definition
```ts
interface WeaponDef {
  kind: "projectile" | "beam" | "missile" | "pd";
  mount: "fixed" | "turret";
  arc?: [number, number];        // deg, turret only, relative to mount axis
  traverseRate?: number;         // deg/s
  muzzle: Vec2;                  // local
  ammoType?: string;             // projectile, missile, pd
  internalMagazine: number;      // rounds held in the weapon itself
  fireInterval: number;          // s
  powerPerShot?: number;         // J
  powerDraw?: number;            // W while firing (beams)
  heatPerShot?: number;          // J
  heatWhileFiring?: number;      // W (beams)
  range: number;                 // m (beams; max lifetime range for projectiles)
  spread: number;                // deg, 1σ
  projectile?: { speed: number; mass: number; damage: number; lifetime: number;
                 proximityFuse?: number; burstRadius?: number; burstDamage?: number };
  beam?: { dps: number; falloffStart: number };
  missile?: MissileDef;
}
```

### 4.3 Ship design (save file)
```ts
interface ShipDesign {
  formatVersion: 1;
  id: string;                    // UUID, stable across edits
  name: string; author?: string; description?: string;
  drone?: boolean;               // design is a drone type (hangar-launchable)
  createdAt: string; modifiedAt: string;   // ISO 8601
  parts: { uid: string; partId: string; x: number; y: number; angle: number /*deg*/;
           weaponGroup?: number }[];
  weaponGroupModes: Record<number, "hold" | "manual" | "ai">;
  powerPriority: PowerGroup[];   // highest priority first
  // connections are NOT stored; they are recomputed from geometry
}
type PowerGroup = "propulsion" | "gyro" | "weapons" | "pointDefense" | "hangar";
```

### 4.4 Scenario
```ts
interface Scenario {
  id: string; name: string; description: string;
  budget: number;                    // fleet total
  maxPlayerShips: number;
  allowedParts?: string[];           // default: all
  arena: { width: number; height: number;
           asteroids: AsteroidSpawn[]; gravityWells: GravityWell[] };
  playerSpawns: Transform[];
  enemies: { designId: string; aiProfile: string; spawn: Transform; team: number }[];
  objective: { type: "destroyAll" } | { type: "survive"; seconds: number }
           | { type: "protect"; designId: string };
  seed: number;
}
```

### 4.5 Export and sharing
**Goal:** a ship file is **self-contained**. Anyone with the game can import it and get the identical ship, even when it uses custom parts they don't have.

#### Part catalogues and identity
- **Core catalogue:** the default parts that ship with the game. IDs use the `core:` prefix, and the catalogue has a `catalogueVersion`.
- **User parts:** parts that are edited or created. The in-game part editor comes later, but hand-edited JSON works from day one. IDs use the `user:<authorKey>/<name>` prefix. `authorKey` is a short random ID generated once per installation, so different players' parts never collide.
- Every part definition has a **content hash**: SHA-256 of its canonical JSON (sorted keys, normalized numbers), truncated to 16 hex characters. The hash is what really identifies a part. The id and rev are for humans.
- **Editing any part, core included, produces a user part.** Editing a core part forks it into `user:…` and leaves the core part untouched. Core definitions therefore always mean the same thing for a given `catalogueVersion`.

#### Export bundle
```ts
interface ShipExport {
  format: "spacegame.ship";            // or "spacegame.fleet"
  formatVersion: 1;
  gameVersion: string;
  exportedAt: string;
  core: { catalogueVersion: string;
          parts: Record<string /*core id*/, string /*hash*/> };  // only core parts used
  designs: ShipDesign[];               // [0] = the main ship; also drone designs it needs
                                       // (a fleet export lists all ships)
  dependencies: {
    parts: PartDef[];                  // every non-core part used, transitively
    ammoTypes: AmmoTypeDef[];          // non-core ammo types used
  };
  summary: { cost: number; mass: number; class: string; partCount: number };  // informational only
}
interface AmmoTypeDef { id: string; name: string; }
```

**Dependency collection** walks everything the design references and includes every item that is not in the core catalogue:
- Parts placed on the ship.
- `mirrorOf` variants.
- Ammo types used by magazines and weapons.
- Drone designs referenced by hangars (`hangar.droneType` points to a `ShipDesign` id), and those designs' parts, applied recursively.

The core parts used are listed with their hashes, so the importer can detect balance differences between game versions. Their full definitions are not embedded.

#### Sharing methods (all carry the same bundle)
| Method | How |
|---|---|
| **File** | Export as `<name>.ship.json` or `<name>.fleet.json`, pretty-printed and readable |
| **Clipboard** | "Copy ship" puts the JSON on the clipboard, ready to paste into chat, forums or issues |
| **Share string** | "Copy share code" produces `SG1:` + base64url(deflate(minified JSON)). It's compact, one line and safe in chat apps. `SG1` is the code version |
| **Import** | File picker, drag-and-drop onto the editor or library, or **paste anywhere in the library** (both raw JSON and `SG1:` codes are detected automatically) |

The local library is stored in IndexedDB. It holds designs, user parts and imported parts, and can show which designs use each part.

#### Import rules
1. **Validate** the bundle against the JSON schema. Reject unknown `format`, or a newer `formatVersion` than the game supports, with a clear message.
2. **Sanitize:** imported files are pure data and are never executed. Enforce sanity limits on custom parts, such as maximum vertices, size, mass, thrust, HP and ammo. Out-of-range values reject the import with a list of offending fields. Clamping silently would change the ship.
3. **Resolve core parts:**
   - Missing core part (exported from a newer game version): reject, and list the missing ids.
   - Hash mismatch (core part rebalanced since export): import and use the *current* core part, with a warning that the ship may perform differently. There's an option to **"pin original"**, which keeps the old definition embedded and turns it into a user part. For that to work, the exporter can optionally embed the full core definitions it used (the "archival export" checkbox). *(Implemented in `core.archived`; pinned parts are named `user:pinned/<name>~<first 6 hash chars>`.)*
4. **Resolve user parts and drone designs:**
   - Same id and same hash as the local copy: reuse the local one.
   - Same id but different hash: import as a **renamed copy** (`…/engine.ion~2`) and rewrite references inside the imported designs. Never overwrite a local part silently.
   - New id: add to the library, marked "imported from <author>".
5. **Design id collision:** if the same design id exists locally, offer **Replace**, **Keep both** (assign a new UUID) or **Cancel**.
6. **Recompute** connections, mass properties, cost and class from geometry and definitions. The bundle's `summary` is never trusted. Budget legality is checked when a scenario is chosen, not at import.

#### Other exports
- **Fleets** use the same bundle format with `format: "spacegame.fleet"` and several entries in `designs`.
- **Scenarios** use the same dependency mechanism, so custom enemy ships and parts travel with them (`format: "spacegame.scenario"`).
- **Replays** later reference designs by hash.

---

## 5. Prototype component catalogue (v0)

The numbers are left for balancing. This table shows what each part is for.

| Part | Category | Role / notes |
|---|---|---|
| Hull plate (triangle, square, rectangle, trapezoid, in sizes S/M/L) | structure | Light, cheap, all `snap` edges. Fills out the frame |
| Hull edge pieces | structure | One `hull` edge, the rest `snap`. Forms the outer skin |
| Armor plate (several shapes) | armor | Heavy, high HP, flat `armor` reduction. Usually `hull` on the outside |
| Command module | command | Required, exactly one. Has a built-in gyro. Losing it means defeat |
| Main engine S/M/L | propulsion | High thrust, gimbals toward the CoM, nozzle is a `function` edge |
| RCS thruster block | propulsion | Low thrust, fixed direction, creates torque. Used for strafing and extra rotation |
| Gyroscope | propulsion | Adds torque and draws power |
| Fuel tank S/M/L | storage | Fuel mass counts toward ship mass |
| Reactor S/M | power | Steady power output, heavy, produces heat |
| Battery | power | Buffers power for bursts |
| Radiator panel | thermal | Dissipates through exposed `function` edges. Can extend/retract. Fragile when extended |
| Heat sink | thermal | Increases the ship's heat capacity |
| Kinetic cannon (fixed) | weapon | High damage, slow fire, aimed with the ship |
| Autocannon turret | weapon | Medium damage, fast fire |
| Laser turret / fixed lance | weapon | Beam that uses power and generates lots of heat |
| Missile launcher | weapon | Fires guided missiles drawn from a missile magazine |
| PD turret (gatling) | weapon/pd | Automatic, fires at missiles and drones |
| Flak PD turret | weapon/pd | Saturation fire: proximity-burst shells against swarms |
| Magazines: kinetic / autocannon / missile / flak | storage | Ammo mass counts toward ship mass and drops as rounds are fired |
| Drone hangar | hangar | Stores and launches one predefined drone type |

---

## 6. Physics and flight

### 6.1 Rigid body
- Each ship is **one rigid body** with **one collision fixture per part** (or per convex piece).
- **Mass properties are computed by the game**, not by the physics engine, then applied with `setMassData`:
  - Part mass = dry mass + current fuel + current ammo.
  - Ship mass: $M = \sum m_i$
  - CoM: $\vec c = \frac{\sum m_i \vec c_i}{M}$
  - Inertia about the CoM: $I = \sum (I_i + m_i\,|\vec c_i - \vec c|^2)$, where $I_i$ is the polygon's own inertia assuming uniform density, scaled to $m_i$.
- Mass properties are recomputed when the configuration changes and when fuel or ammo mass changes by more than 0.5% since the last recompute. The body's position is adjusted so that a CoM shift does not teleport the ship.
- Destroyed parts keep their mass and fixtures (Section 8).

### 6.2 Forces per tick
Linear acceleration: $\vec a = \frac{\sum \vec F}{M}$. Angular acceleration: $\alpha = \frac{\sum \tau}{I}$, with $\tau = \vec r \times \vec F$ for forces applied away from the CoM.

### 6.3 Main engines (always thrust through the CoM)
- Each main engine has a nominal thrust axis $\hat t$ and a mount point $\vec p$.
- The desired thrust direction points from the mount point through the CoM: $\hat f = \frac{\vec c - \vec p}{|\vec c - \vec p|}$, which is opposite the exhaust.
- $\varphi$ is the angle between $\hat t$ and $\hat f$.
  - If $\varphi \le$ `gimbalMax`, the engine fires along $\hat f$ with magnitude $T \cdot u \cdot \cos\varphi$, where $u$ is the throttle (0–1). Fuel use is based on the full $T \cdot u$, so the gimbal angle is an efficiency loss.
  - If $\varphi >$ `gimbalMax`, the engine **cannot fire**. The editor warns about this. At runtime it can happen when the CoM shifts (fuel burn, ammo use), and the HUD then shows the engine as "out of gimbal".
- Main engines therefore **never produce torque**.
- Fuel flow: $\dot m = \frac{T u}{I_{sp}\,g_0}$, drawn from fuel tanks on the same network (Section 7).

### 6.4 RCS thrusters
- RCS thrusters apply a fixed-direction force at their mount point, so they produce both force and torque.
- They are used for strafing, braking and extra rotation.

### 6.5 Rotation (always available)
- The command module's built-in gyro torque, plus any gyroscope parts, gives the base rotation torque: $\tau_{gyro} = \sum \tau_k \cdot hpFactor_k \cdot powerFactor_k$.
- **Rotation never needs engines.** RCS thrusters only make it faster.
- Turn rate emerges from the design ($\alpha = \tau / I$), so large or spread-out ships turn slowly.
- **Rotational stabilization** is always on. With no rotation input, the controller brakes angular velocity to zero using the gyro (and RCS if needed).
- Optional gameplay cap on maximum angular speed: `maxOmega`, set as a global constant.

### 6.6 Flight controller and thrust allocation
The player and the AI produce the **same control intent**:
```ts
interface ControlIntent {
  thrust: Vec2;          // desired local linear force direction × magnitude [-1..1]
  rotate: number;        // desired angular command [-1..1]
  faceAngle?: number;    // optional absolute heading target (face-cursor / AI)
  speedKill: boolean;
}
```
- An allocator turns the intent into throttles $u_i \in [0,1]$ for every main engine and thruster, plus the gyro command.
- It solves a bounded least-squares problem: minimize the error from the desired force and torque, with a small penalty on fuel use.
- The solver runs a fixed number of iterations of projected gradient or NNLS, in a fixed order, so it is deterministic. *(Implemented as projected coordinate descent, 30 sweeps.)*
- The gyro takes torque demand first. RCS covers any remaining torque. *(Implemented by giving the gyro a lower cost than fuel-burning thrusters, so the solver prefers it and also uses it to cancel parasitic RCS torque.)*
- Both force axes share one normalization scale. A force axis the pilot did not request gets a lower weight (0.2), so a slightly gimballed engine still gives full thrust when only "forward" is pressed. Speed kill weights both axes fully.
- Main-engine gimbal directions are fixed for each tick (Section 6.3), which keeps the problem linear.

### 6.7 Speed kill (flight assist)
- **Activated by command**, not automatically: key **X** toggles it.
- While active, the controller sets the desired acceleration to $\vec a = -\frac{\vec v_{rel}}{\tau_{kill}}$, clamped to what the ship can achieve. It uses real engines and **consumes fuel**.
- **Two modes:**
  - **X (keep orientation when it works):** the default. Brakes using whichever engines and thrusters face the right way, without rotating the ship. If the ship lacks thrust against its velocity (keep would take more than 1.5× as long as flip-and-burn, including the turn), X switches to flip-and-burn by itself. Most ships have far more forward thrust than reverse, so this is the common case when flying forward.
  - **Shift+X (flip and burn):** rotates the ship until the strongest main-engine axis points retrograde, burns, and leaves the ship facing that way. The flight controller picks the engine axis with the highest available thrust.
- Speed kill ends when $|\vec v_{rel}| < \varepsilon$, when the player gives any thrust input, or when X is pressed again. Rotation input cancels flip-and-burn and switches to keep-orientation.
- The AI can use either mode.
- **Reference frame hook:** $\vec v_{rel} = \vec v - \text{referenceVelocity}()$. The prototype returns world zero. Returning the selected target's velocity later gives target-relative speed matching.

### 6.8 Collisions
- The physics engine resolves collisions between ships, asteroids and arena objects.
- Collision damage to each part involved: $\text{damage} = k \cdot \max(0, J - J_{threshold})$, where $J$ is the contact impulse.

### 6.9 Gravity wells (implemented, not used in default scenarios)
- Each well is a point mass: $\vec g = -\frac{GM}{r^2 + s^2}\hat r$, with softening $s$ and an optional cut-off radius.
- Gravity applies to ships, asteroids, missiles, drones and projectiles.
- A well has a solid core body that you can collide with.

---

## 7. Resources: networks, power, fuel, ammo, heat

### 7.1 Resource networks
- The ship's **connection graph** has one node per *intact, conducting* part and one edge per snapped connection.
- Each connected subgraph is a **network**. **Power, fuel and ammo flow only within a network.**
- Destroyed parts are removed from the graph. They still hold the structure together physically but **carry nothing**, so hitting a central conduit part can cut off a whole wing.
- Networks are recomputed when any part's state changes.
- **Command link:** a network that does not contain the command module cannot take player or AI commands. Its engines, thrusters and manual weapons go idle. Its automatic point defense keeps working while it has power and ammo.

### 7.2 Power
- Each tick, for each network:
  1. **Supply** = the sum of reactor output (reactors follow demand up to `maxOutput × hpFactor`) plus battery discharge (up to `maxDischarge`, limited by stored charge).
  2. **Demand** is grouped into power groups: `propulsion`, `gyro`, `weapons`, `pointDefense`, `hangar`.
  3. Supply is allocated **by the player's priority order**. Each group is fully served before the next. The first group that can't be fully served gets the remainder, shared proportionally among its consumers. Lower groups get nothing (brownout).
  4. Surplus charges batteries, up to `maxCharge`.
- A consumer's `powerFactor` is the fraction of demand it received. It scales that consumer's output (thrust, torque, rate of fire). Weapons that fire per shot need their full shot energy.
- The power priority order is set in the editor and can be changed live in combat from a HUD panel (P).

### 7.3 Fuel and ammo
- Engines draw fuel from tanks on their network, taken proportionally from all of them.
- Weapons draw from their internal magazine. The internal magazine refills from magazines of a matching `ammoType` on the same network, at a reload rate.
- Fuel and ammo mass update the part mass, and through it the ship's mass properties (Section 6.1).

### 7.4 Heat (one global pool per ship)
- Ship heat capacity: $C = C_{base} + \sum$ heat-sink capacity.
- Per tick: $H \mathrel{+}= \left(\sum \text{heat}_{gen} - \sum \text{dissipation}_{radiators} - \text{hull}\right)\Delta t$, clamped at $H \ge 0$.
- **Hull radiation:** every ship sheds 1.5 kW per metre of exposed outline (radiator faces excluded, they count as radiators). Small or cool ships manage without radiators; hot ones need them.
- Radiators glow red in proportion to the ship's heat and how well they work (exposure, extended, HP), so the player can see them working.
- Heat comes from reactors (in proportion to output), engines and thrusters (in proportion to throttle), weapons (per shot or per second), gyros and hangars.
- **Radiator dissipation** = `dissipation × exposedFraction × (extended ? 1 : retractedFactor) × hpFactor`.
  - `exposedFraction` is the share of the radiator's `function` edge length that is not covered. It is computed in the editor.
  - Extended radiators take `extendedDamageMult` times damage. The radiator toggle is key **R**.
- **Thresholds** (as a fraction of $C$):

| Heat level | Effect |
|---|---|
| < 70% | Normal |
| 70–100% | All heat producers throttle linearly from 100% down to 50% output |
| > 100% | Overheat: parts that produce heat take damage in proportion to the excess. The HUD shows a warning |

---

## 8. Damage and destruction

- Every part has HP. Its function scales with **`hpFactor = hp / maxHp`**: engine thrust, reactor output, gyro torque, battery capacity, radiator dissipation, and weapon rate of fire and accuracy.
- **Armor parts** reduce each hit by a flat amount: `damage = max(minDamage, hit − armor)`. They are heavy and have high HP.
  - Projectiles and beams hit the first fixture along their path, so outer armor naturally shields inner parts.
- **Destroyed** (hp ≤ 0) parts become **inert wreck parts**:
  - They keep their mass and collision shape. They take no further damage themselves.
  - They act as **weakened armor**. A wreck absorbs `wreckAbsorb` of each hit (default 50%, global constant). The rest continues along the projectile's ray or beam to the next part behind it. Blast damage is reduced the same way for parts sheltered behind wrecks.
  - They lose all function and are removed from resource networks.
  - They are drawn as charred and dark.
- Optional (Should priority): destroyed fuel tanks, magazines and reactors **explode**, dealing area damage to nearby parts.
- The physics model has no splitting or detachment in the prototype. Connection overlap data is kept for it (Section 3.3).
- Repairs are deferred. Part state is designed so HP can go back up later.

### 8.1 Defeat conditions
A ship is **defeated** when either:
1. its **command module is destroyed**, or
2. it has **no working propulsion and no working weapons**: the effective thrust of all main engines and RCS is 0 (gyros don't count), and no weapon can fire because it has no ammo, no power or is destroyed.

A defeated ship becomes a drifting wreck. Its AI and controls are disabled and its PD stops.

---

## 9. Weapons and combat

### 9.1 Mounts
- **Fixed:** fires along the mount axis with a small aim cone (e.g. ±3°), auto-aimed within that cone. You aim it by turning the ship. Fixed weapons are cheaper and stronger than turrets of the same tier.
- **Turret:** rotates within an `arc` at `traverseRate`.
  - **Self-occlusion:** in the editor, rays are cast from the muzzle against the ship's own parts to find blocked angle ranges.
  - At runtime a turret never fires into a blocked range. It keeps tracking, but shows as blocked.

### 9.2 Weapon groups and modes
- Weapons are assigned to groups **1–9**. Pressing a number selects that group, and Shift+number adds a group to the selection.
- Selected **manual** groups aim at the mouse cursor and fire on **left mouse button**.
- **Group modes:**
  - `hold`: never fires.
  - `manual`: aims and fires on player input while the group is selected. When not selected it holds fire.
  - `ai`: fires at will. In the prototype this is a **stub** that reuses the PD targeting code (Section 9.6) against ships.
- **G** cycles the mode of the selected groups.
- When a ship is AI-controlled, all of its groups run through the ship AI.

### 9.3 Projectiles
- Projectiles are lightweight entities, not physics bodies.
- Velocity at launch = shooter's velocity + muzzle velocity, with random spread from a seeded RNG.
- Projectiles fly ballistically and respond to gravity wells.
- Hit detection casts a ray from the previous position to the current one each tick, so fast rounds can't tunnel through parts. The first part fixture the ray crosses is hit.
- On impact: apply damage to that part (after armor), and apply an impulse $m_p \vec v_{rel}$ to the target body.
- Projectiles disappear when their lifetime runs out.

### 9.4 Beams
- A beam is a raycast from the muzzle out to `range` each tick while firing.
- It deals continuous damage (`dps × Δt`) to the first part it hits, falling off beyond `falloffStart`.
- Beams draw power while firing and produce a lot of heat.

### 9.5 Missiles
```ts
interface MissileDef { mass: number; thrust: number; fuel: number /*s of burn*/;
  turnRate: number; hp: number; damage: number; proximityFuse: number;
  blastRadius: number; guidance: "pn" | "pursuit"; navConstant?: number }
```
- Missiles are entities with point-mass physics, a heading and a turn-rate limit. They respond to gravity.
- Guidance is proportional navigation (N≈3–4). They coast when their fuel runs out.
- The target is the ship selected with **right-click**. Perfect information means no lock time.
- A missile has HP and can be shot down by PD and by any projectile or beam.
- It detonates on its proximity fuse or on contact, dealing blast damage to parts within the radius, falling off with distance.
- Missile launchers are fired with **M**, or through the launcher's weapon group.

### 9.6 Point defense
- PD turrets are **always automatic**. They are not part of the weapon groups.
- They engage enemy missiles and drones within range and arc, ranked by soonest time-to-impact.
- PD fires at the target's lead position: the intercept solution for constant target velocity.
- **Flak PD** fires proximity-fused burst shells, which saturate an area against swarms.
- Each PD turret has a toggle to also engage ships when no missiles or drones are present.
- The PD targeting module is shared with the AI-mode stub (Section 9.2).

### 9.7 Drones
- The prototype has **fixed drone types**, each stored as an ordinary `ShipDesign` file built from catalogue parts and flagged `drone: true`. This lets custom drones drop in later without changes.

| Drone | Role |
|---|---|
| Attack drone | Small, fast, one light gun. Harasses the selected target |
| PD drone | Escorts its mother ship and shoots at missiles |
| Decoy drone | Missiles and PD prefer it as a target. It has a short lifetime |

- A hangar part stores N drones of one type. **H** launches drones from all hangars (one every `launchInterval`). Drones then run their own simple AI.
- Drones are full rigid bodies with the same physics. They have limited fuel, and drop to inert when out of fuel or out of control range.
- *Should priority:* drones return to the hangar to be refuelled and rearmed.

---

## 10. Controls (piloted ship)

| Input | Action |
|---|---|
| W / S | Thrust forward / backward (ship-relative) |
| A / D | Strafe left / right |
| Q / E | Rotate counter-clockwise / clockwise |
| F | Toggle "face cursor" (ship turns toward the mouse) |
| X | Speed kill on/off (keep orientation) |
| Shift+X | Speed kill, flip and burn |
| Mouse | Aim the selected turret groups |
| LMB | Fire selected manual groups |
| RMB | Select target (missiles, AI-mode weapons, allied orders later) |
| 1–9 / Shift+1–9 | Select / add weapon group |
| G | Cycle selected groups' mode (hold → manual → AI) |
| M / Shift+M | Launch one missile / a salvo at the target |
| H / Shift+H | Launch one drone / all drones (help is ? / F1) |
| R | Extend / retract radiators |
| O | PD also engages ships when no missiles or drones are in reach |
| B | Eject mode: click a part of your ship to jettison it, with everything attached only through it (not the command module). B or Esc leaves |
| Shift+B | Jettison all wrecked parts |
| P | Power priority panel |
| Tab | Switch controlled ship (the previous one goes to AI) |
| Ctrl+LMB / Ctrl+Shift+LMB | Select / add allied ships for orders |
| J / K / L | Order the selected allies: follow me / attack my target / hold position |
| Space | Pause (orders can be given while paused) |
| + / − | Time scale (0.25× to 2×) |
| Mouse wheel | Zoom |
| C | Camera mode: follow ship / follow ship + target / free |

### 10.1 Camera (for mixed scales)
- **Follow + target** (the default) zooms automatically so that both the controlled ship and its target stay framed.
- Ships too small to see at the current zoom are drawn as class icons with a minimum on-screen size.
- Off-screen ships, missiles and drones show as edge indicators.
- Projectiles have a minimum rendered length, so they stay visible when zoomed out.

---

## 11. AI

### 11.1 Principles
- The AI outputs the **same `ControlIntent`** and weapon commands as the player. Same physics, no cheating.
- The AI reads the ship's **capabilities profile**, recomputed when the ship takes damage:
  - maximum acceleration in each direction, turn time, top Δv
  - weapon ranges, arcs and damage per second
  - which weapons are fixed and which are turrets
  - heat and power headroom
  - missile and drone stock

### 11.2 Behaviour
- Behaviour is chosen with **utility-based selection**, re-evaluated about every 0.5 s. Each behaviour produces a desired velocity and heading, which the flight controller turns into a `ControlIntent`.

| Behaviour | When it applies |
|---|---|
| Approach | Out of the ship's best weapon range |
| Hold range | At the preferred engagement range |
| Orbit / broadside | Mostly turret armament: maximize the number of turrets that can fire |
| Face and attack | Mostly fixed armament: point the nose at the lead position |
| Evade | Incoming missiles: turn perpendicular to them, launch decoys |
| Retreat | Heavy damage, or out of ammo or fuel |
| Cool down | Heat above 70%: stop firing beams, cut thrust, extend radiators |

- **Fire control:** fire when the predicted hit probability is above a threshold. Launch missiles in volleys, timed to saturate the enemy's PD.
- **AI profiles** set behaviour weights per enemy, such as aggressive, kiter or brawler. They are defined in data and referenced by scenarios.
- **Targeting:** choose by threat ÷ distance, preferring weakened targets.
- Allied AI uses the same system, following the player's ship by default.

### 11.3 Allied orders
Orders replace an ally's top-level goal. Its utility AI still handles evasion, cooling down and retreating.

| Order | Behaviour |
|---|---|
| Follow me | Hold formation near the player's ship and engage threats within range |
| Attack my target | Focus the player's current target (RMB) |
| Hold position | Speed kill, then hold this point, engaging anything in range |

---

## 12. Arena and scenarios

- **Arena:** a rectangle. Near the edge the HUD shows a warning, and a soft boundary force pushes inward, growing quadratically with distance past the edge.
- **Asteroids:** static or slowly drifting convex polygons with mass. They serve as cover and as collision hazards. They are indestructible in the prototype.
- **Gravity wells:** supported (Section 6.9) but not used in the default scenarios.
- **Scenarios:** a handmade list (target about 6–10) with a growing budget, a defined set of enemies and an objective (`destroyAll`, `survive`, `protect`). All parts are unlocked. A scenario is complete when its objective is met, and the result is saved locally.
- Enemy designs are made in the same editor and stored as `ShipDesign` JSON.

---

## 13. Technical architecture

### 13.1 Stack
- **TypeScript**, running in the browser, built with **Vite**.
- **Planck.js** (a Box2D port) for collision and rigid bodies. Mass properties and forces are applied by the game.
- **PixiJS** for WebGL rendering, styled through the theme layer (Section 13.7).
- **Vitest** for tests. The headless sim also runs in **Node**.

### 13.2 Modules
```
/src
  /data       part catalogue, designs, scenarios, schemas, loaders
  /sim        pure TS, no DOM — deterministic simulation
    ship/       ShipModel, mass properties, networks, part state
    physics/    Planck wrapper, forces, gravity, collisions
    flight/     ControlIntent, allocator, speed kill
    systems/    power, fuel, ammo, heat
    combat/     weapons, projectiles, beams, missiles, PD, drones, damage
    ai/         capabilities, utility AI, profiles
    scenario/   setup, objectives, defeat checks
  /editor     geometry, snapping, validation, overlays
  /render     Pixi scene, interpolation, effects, theme reader
  /themes     CSS theme files (neon.css = default)
  /ui         HUD, menus, panels
  /headless   CLI scenario runner for tests and balancing
```
The `sim` module never imports `render`, `ui` or `editor`. Rendering reads a sim snapshot each frame.

### 13.3 Tick order (60 Hz)
1. Gather input → `ControlIntent`s (player and AI)
2. Update networks (if dirty)
3. Power allocation
4. Flight allocation → engine, thruster and gyro outputs (scaled by power, HP and heat throttle)
5. Fuel consumption
6. Apply forces: thrust, gyro, gravity, boundary
7. Physics step (Planck)
8. Collision damage
9. Weapons fire → spawn projectiles, missiles and drones; resolve beams
10. Move projectiles and missiles → hits and detonations
11. Heat update
12. Part state updates (destruction → inert, network dirty)
13. Mass property recompute (if needed)
14. Defeat and objective checks

### 13.4 Determinism
- All randomness comes from a seeded RNG owned by the sim. `Math.random` is banned inside `/sim`.
- Iteration order is fixed (stable IDs, sorted). The timestep is fixed. Rendering has no feedback into the sim.
- Given the same seed and inputs, the result is the same on the same JS engine. Cross-browser bit-exactness is **not** guaranteed, and that's acceptable before multiplayer. Replays store the seed plus input streams.

### 13.5 Performance targets
- 10 ships with up to 150 parts each.
- 500 projectiles, 40 missiles and 30 drones at the same time.
- Steady 60 Hz sim on a mid-range laptop.
- The headless runner should run at least 20× real time.

### 13.6 Testing
- **Unit tests:** polygon mass properties, CoM and inertia, snapping and connection detection, gimbal logic, the allocator, power priority allocation, the heat model, network splits.
- **Golden-run tests:** a fixed seed plus fixed inputs must produce the same final state hash.
- **Balance harness:** run design A vs. design B N times headless and report win rate, time to kill and damage breakdown.

### 13.7 Visual style and theming
- **Default look: neon wireframe.** Everything is drawn as abstract geometry: glowing polygon outlines on a dark background, with lines, arcs and particles for effects. There are no sprites or textures.
- **Themes are CSS-driven.** The game's visuals are defined by CSS custom properties in a theme stylesheet. The renderer reads them at startup and again whenever the theme changes, using `getComputedStyle` on a set of hidden, semantically classed probe elements. Changing the look means editing or swapping a `.css` file, with **no change to game logic or rendering code**.
- **Semantic style keys:** the renderer never hardcodes a colour. Every drawn element asks for a style using a semantic selector:

| Element | Example selector | Properties |
|---|---|---|
| Part outline / fill | `.part.cat-propulsion.team-1.state-damaged` | `--stroke`, `--stroke-width`, `--fill`, `--fill-alpha`, `--glow`, `--glow-strength` |
| Destroyed part | `.part.state-wreck` | same |
| Thrust plume | `.fx-thrust` | `--color`, `--length-scale`, `--glow` |
| Projectile / beam / missile trail | `.fx-projectile.kind-flak` | `--color`, `--width`, `--trail-length` |
| Explosion | `.fx-explosion.size-l` | `--color`, `--particles`, `--duration` |
| Turret arc / CoM / network overlays | `.overlay-arc`, `.overlay-com`, `.overlay-net-2` | `--stroke`, `--dash` |
| Arena, asteroids, gravity wells | `.arena-bg`, `.asteroid`, `.gravity-well` | `--fill`, `--stroke`, `--grid` |
| HUD | ordinary DOM + CSS | everything |

- Selectors are matched with the normal CSS cascade, so a theme can set general rules (`.part`) and override specific ones (`.part.team-2.cat-armor`).
- Resolved styles are cached per selector, so rendering never queries CSS every frame.
- The HUD, menus and editor panels are plain HTML/CSS layered over the canvas, so the same theme file styles them directly.
- The prototype ships with one theme (`neon.css`). A second minimal theme (for example `flat.css`) acts as the test that switching works.

---

## 14. Decision log

| Topic | Decision |
|---|---|
| Cut-off sections | No player or AI control. Automatic PD still works while it has power and ammo (Section 7.1) |
| Speed kill | X keeps orientation when it can, otherwise flips; Shift+X always flips and burns (Section 6.7) |
| Budget | Per fleet, set by the scenario (Section 12) |
| Wrecks | Weakened armor that absorbs 50% of each hit and passes the rest on, until its shadow life runs out (Section 8; see Wreck shadow life) |
| Gimbal | Cos φ thrust loss. Can't fire outside the gimbal limit, so main engines never make torque (Section 6.3) |
| Visuals | Neon wireframe, abstract geometry, themed by CSS (Section 13.7) |
| Scale | Mixed classes from drones to cruisers (Section 2.1) |
| Allies | Tab switching plus follow / attack / hold orders (Section 11.3) |
| Sharing | Self-contained JSON bundles that include every non-core dependency, plus clipboard and `SG1:` share codes. Imports never overwrite silently (Section 4.5) |
| Balance tuning | Fights target 1–5 min (median engagement, first hit to end, ~150 s). An automated tuner fights the archetypes and scenarios in parallel worker threads and adjusts a balance overlay (pace: HP with ammo; weapon damage by win rate; power and heat by throttle time; command HP; ammo). Ammunition and fuel knobs are mass-neutral, so tuning never changes handling. The result is reviewed as a catalogue diff before it is applied (catalogue v0-6, see balance-pass-2.md) |
| Keyboard layout | Keys are read by physical position (KeyboardEvent.code): the row above the letters selects weapon groups on any layout (on Czech the 1 key types "+"), time scale is on the +/− and [ ] positions and the numpad. Every flight starts at ×1 |
| Radiators | Nothing of the same ship may sit within 1 m in front of a radiating face (editor error; in flight a blocked face radiates nothing), so radiators cannot be hidden inside hollow armor |
| Ship classes and agility | Catalogue v0-7: large engine 250 kN and 2 t, hull plates 60 kg/m², heavier heavy guns. Fighters 14–33 m/s², gunboats about 10, destroyers 16–20, cruisers 9–13, battleship about 5 |
| Lasers | Laser turret damage −25 % and heat +50 %; lance damage −10 % and heat +30 % (v0-7) |
| AI types | Aggressive, defensive (guard order with a radius), retreating (fighting withdrawal) and cautious, each a profile from a base profile plus 3–5 parameters (docs/ai-types.md). Range is planned at a fixed 20 % hit probability. Retreat is a withdrawal at 60 % of top speed facing the threat. Cooling AI also holds its guns above 90 % heat |
| Part editing | Core catalogue is fixed. Edits fork into namespaced user parts identified by content hash. The editor UI comes later |
| Basic power | Command modules include a 30 kW auxiliary generator (enough for their own gyro), so simple ships fly without a reactor; gyroscopes and weapons need real reactors (implemented in M3) |
| Power demand timing | Propulsion power demand uses the previous tick's throttle (power is allocated before thrust, plan §13.3); gyros draw their full rating while the ship is alive |
| Cut-off sections | Consumers in a network without the command module draw no power and take no commands; their reactors still charge their own batteries. Point defense will be the exception (M5) |
| Weapon heat | A powered weapon heats in proportion to the power it actually receives (browned-out beams barely heat) |
| Editor guidance | While placing or dragging, free attach edges glow green, no-attach edges red, and the status line states what will connect, what is too short (< 0.25 m) or which outer/functional edge blocks it |
| Recoil | Firing pushes the shooter back (see Recoil damping) |
| Beam armor | Armor reduces beam damage per second (dps − armor, at least minDamage/s), the per-second analogue of the per-hit rule |
| Explosions | Destroyed fuel tanks (≥ 10 % full), magazines (≥ 10 % full) and reactors (not the command module's auxiliary generator) blast their own ship's parts: radius 3–4 m, linear falloff, armor applies, chains resolve in uid order |
| Weapon groups | Ungrouped weapons belong to group 1. AI-mode groups (M4 stub) shoot at the selected target, else the nearest non-defeated enemy, leading projectiles. Turrets fire within 0.15° of the aim (or their spread) |
| Defeat enforcement | Defeat is always evaluated; scenarios and test flights enforce it (defeated ships stop responding and firing). Bare physics tests do not |
| Speed kill auto | Playtest 1: X alone barely worked on ships without retro thrust. X now keeps orientation only while that is not much slower than flip-and-burn (factor 1.5, estimated from the thrust available along the velocity and the turn time), otherwise it flips. Shift+X still forces flip |
| Recoil damping | Playtest 1: full Newtonian recoil was too strong. Rounds now pass 10 % of their momentum to the shooter (recoil) and to the ship they hit (`COMBAT.momentumTransfer`) |
| Turret turn rate | Each turret's `traverseRate` (deg/s) is required by validation and shown in the editor's part info. Core turrets range from 35°/s (heavy cannon turret) to 360°/s (PD gatling) |
| Hull radiation | Playtest 1: the old fixed 20 kW passive cooling is replaced by 1.5 kW per metre of exposed hull outline. The HUD splits heat into sources (reactors, engines, gyros, weapons) and sinks (hull, radiators) |
| Ejection | Any part except the command module can be jettisoned in flight, intact or wrecked. Everything that would no longer be structurally attached to the command module goes with it (wrecks still count as structure), and the whole cluster leaves as one inert debris body. In eject mode the hover highlight and the HUD show every part that will leave at 3 m/s (equal and opposite push on the ship), taking its fuel, ammo and heat share (its mass share of the base pool plus its own heat sink). Structure, networks and mass are recomputed. Debris blocks shots and can collide but takes no damage; at most 200 are kept. Ejection is a one-shot input in replays (`eject: [uids]`) |
| Editor palette | Categories are collapsible (command and structure open by default, the choice is remembered per browser). A search box filters by name, id, category, weapon kind/mount or ammo type. Hovering a part shows its key numbers |
| Connection graph | Editor overlay (G, or Overlays → Connection graph): a node per part, an edge per structural connection, and a coloured lane on each edge for every resource it carries (power, fuel, ammunition). Each consumer is drawn fed from its nearest source on its network (fewest connections, ties by uid); the sim itself still shares resources across the whole network. Links through non-conducting parts are structure only. Consumers that no source can reach are ringed and listed in the side panel |
| Missile guidance | Proportional navigation in space: lateral acceleration N·Vc·(line-of-sight rate) across the line of sight (closing speed counted as at least 50 m/s), the rest of the thrust along it; the heading turns at most `turnRate`. Guidance needs thrust: once its fuel is spent (8 s for the standard missile) a missile stops steering, cannot be decoyed and flies straight on with its fuse live (gravity still bends its path), until it is 500 m outside the arena or has coasted for 60 s. The fuse arms 0.4 s after launch, then fires at the closest approach of each tick's path to any enemy hull within `proximityFuse`; hitting an asteroid or debris detonates it. Rounds and beams hit missiles within 0.8 m |
| Blasts | Missile warheads and flak bursts deal `damage × (1 − d/R)` after armor; each wreck on the line from the blast to a part halves that part's share. Shares are taken from the ship as it was when the blast began. Warheads hurt any ship (friendly fire); flak only hurts hostile ships and missiles |
| Missile launch | M fires one missile from every ready launcher at the selected target. Launchers in a manual group also fire on the trigger, and in AI mode pick their own target. No target, no launch |
| Threat ranking | PD and the shared targeting rank enemy missiles and drones by time to closest approach. Missiles homing on the ship, or anything passing within 150 m, rank ahead of the rest; decoys rank as if three times closer. AI-mode weapons take the selected target first, then the nearest enemy they can engage (range, arc, own-hull blocking) |
| PD | Always automatic and keeps working in sections cut off from command. The "engage ships" toggle is per ship (O), not per turret. Flak shells burst near an enemy missile or drone, or at the predicted intercept time |
| Decoys | A decoy emitter part (`decoy: {strength, lifetime}`) makes its ship a decoy. Each missile gets one roll per enemy decoy within 1200 m (pass with probability = strength) and then homes on the decoy. Decoys go inert after their lifetime |
| Drones | Drone designs are ordinary designs flagged `drone`. Their role comes from their parts: decoy emitter → decoy, PD turret → PD escort, else attack. Hangars launch from their functional edge (H; one every `launchInterval`). Attack drones hold 300 m from the carrier's target (else the nearest enemy), PD drones escort at 35 m, decoys fly away at 60 m/s. A drone goes inert without fuel, beyond 5 km from its carrier, when the carrier is gone or defeated, or (decoys) after its lifetime. Drone weapons hold only their internal magazine. A carrier with drones in its hangars or in flight is not defeated. Returning to refuel (Should) is not done yet |
| Help key | H launches drones (Section 10), so the flight help moved to ? / F1 |
| Beam heat | Beams also heat the ship they hit: 30 % of the beam's power at the target (after range falloff and brownout) goes into its heat pool (`COMBAT.beamHeatToTarget`). A laser lance (900 kW) adds 270 kW, more than most hulls shed without radiators. Beams are drawn as thin lines |
| AI structure | The AI lives in `src/sim/ai` and only writes ship intents and weapon commands (a test enforces it). Each AI ship re-evaluates target and behaviour every 0.5 s (the current behaviour gets +0.15, the current target ×1.2) and steers and fires every tick |
| AI ranges | Preferred range is DPS-weighted over the guns the behaviour uses (turrets for broadside, fixed guns for face-and-attack), each counted out to where it still meets the profile's hit-probability floor against the current target's size, times the profile's range factor. Ships without guns stand off at 70 % of missile range |
| AI movement | Speed toward a goal is capped by stopping distance, counting the time to turn and burn, so ships without retro thrust do not overshoot. Behaviours may turn the ship to burn with its strongest axis when the velocity error is large. Asteroids on a collision course within 5 s are steered around; the arena edge pushes back earlier the faster the ship heads for it |
| AI fire control | AI-mode weapons fire only above the profile's hit-probability floor (target size against the spread cone). Missiles go out in volleys: all launchers loaded, target within 85 % of missile range, at most every `volleyInterval`. Attack and PD drones launch inside `droneLaunchRange`; decoys launch while evading. Above 70 % heat beams hold fire until heat drops under 50 % |
| AI retreat | Below the profile's hull threshold, or out of weapons it was built with, an AI ship retreats. Ships built without guns, missiles or hangars (PD escorts) never retreat for lack of weapons |
| AI profiles | Six profiles in `src/data/ai/profiles.json` (balanced, aggressive, kiter, brawler, sniper, carrier), validated at load: range factor, behaviour weights, retreat threshold, speeds, hit-probability floor, volley interval, drone range, preference for weakened targets |
| Allies | The player's other ships fly under AI (balanced profile) and follow in formation behind the controlled ship. Followers and holders engage only armed enemies within 2 km of their leader or hold point. Tab hands the previous ship to the AI on the same frame. J follow, K attack my target, L hold position; Ctrl+click selects allies for orders (Ctrl+Shift adds), no selection = all allies; orders work while paused. The debug part-destroy tool moved from K to Y |
| Skirmish | The editor's Skirmish button flies the player's gunboat and frigate against an AI gunboat (aggressive), frigate (kiter) and PD picket |
| Balance harness | `npm run balance` fights eight equal-cost weapon archetypes (`src/data/designs/balance/`) AI against AI and writes CSV, JSON and HTML reports with win rates, time to kill, damage by weapon and the 7.6 / 7.7 checks. Pass 1 results and catalogue changes: [balance-pass-1.md](balance-pass-1.md) |
| Turret missile defense | AI-mode turrets shoot at missiles homing on their own ship when impact is less than 4 s away (`COMBAT.turretMissileDefense`), before engaging ships |
| Hangar cost | A hangar's cost includes the drones it holds |
| Scenarios | Eight scenarios in `src/data/scenarios/` teach the mechanics in order: first flight, fixed vs. turret, armor, heat (survive 60 s), power, missiles and PD, escort (protect), mixed fleet. Each has tips and suggested reference designs; a test checks that every scenario's reference fleet, flown by the AI, wins at least one of 20 seeds |
| Objectives | destroyAll: every enemy ship (drones excluded) defeated. survive: the time passes. protect: the team-0 ship spawned from the objective's design must outlive the enemies. Losing every player ship always loses. The result is decided once and does not change |
| Fleet and budget | A fleet is one or more designs added in the editor's scenario panel. It may not exceed the scenario's budget (sum of part costs) or ship count, nor use parts outside `allowedParts`; Start stays disabled until it fits. Results (win/loss, time, damage dealt and taken, parts lost) are kept per browser, and the scenario list shows the best one |
| Editor drag | Moving or rotating a part carries everything that hangs on it, by the same rule as jettison: every part that would lose its connection to the command module without it. The group keeps its shape (rotation turns it about the moved part) and is one undo step. Ctrl+drag moves the part alone; the command module always moves alone |
| Weapon bar | The flight screen shows every weapon group along the bottom: number, mode, weapons alive and loaded rounds, with the selected groups highlighted. Clicking a group selects it, Shift+click adds it |
| Wreck shadow life | A destroyed part keeps a "shadow life" equal to its full HP. Hits wear it down by the share the wreck absorbs (rays) or takes (blasts, collisions). At zero the wreck breaks off with a flash and is gone, and whatever hung only on it drifts off as debris (the jettison rule). The command module's wreck never breaks off. This replaces "Wrecks: absorb 50 % forever" |
| Store explosions | Destroyed fuel tanks and magazines explode in proportion to what they still hold: peak damage 0.6 per kg of fuel or 1.2 per kg of ammunition, radius 3 m × cube root of the stored mass relative to a full small tank (500 kg) or magazine (340 kg); under 5 kg nothing explodes. Replaces the fixed 300 / 400 blasts |
| Weapon group settings | The editor's weapon-group panel creates groups (lowest free number, optionally from the selected weapons), names them, moves weapons between them and deletes them. Each group has a default mode (manual: fires on the trigger; automatic: picks targets and fires by itself; hold) and, for automatic groups, a fire range (m, defaults to each weapon's own range) and a target priority: selected target then nearest, nearest, most dangerous (gun damage per second for its distance), most damaged, drones first, or missiles first (guns shoot down any missile homing on the ship before anything else; without it turrets only take missiles under 4 s from impact). Saved as `weaponGroups` in the design; AI-flown ships use them too |
| Single launches | M launches one missile from the first ready launcher, Shift+M fires every ready launcher; each launcher then reloads for its fire interval (2 s). H launches one drone from the first hangar that is ready, Shift+H queues every drone; each hangar then cools down for its launch interval. The weapon bar shows missiles left, launchers ready and drone stock, with the time until the next launch |
| Armor strips | Armor strip S (1 × ⅓ m) and M (2 × ⅔ m): a third as wide as the armor plates, with a third of their mass, HP and cost and the same armor value, for thin armored skins |
| Launch reload | Missile launchers reload for 10 s after each missile and every hangar waits 10 s between drone launches (was 2 s, and 0.5–1.5 s for hangars), so missiles and drones come in paced volleys |
| Large classes | Two bundled designs for ~2000-point fleets: Warden (gun cruiser, cost 1023, 18 t) with two heavy cannon and two autocannon turrets on each flank for broadside fire, two forward PD turrets, a reactor and gyros; and Tempest (missile frigate, cost 713) with four launchers, two missile magazines, two PD turrets, two light autocannon turrets for close defense and a decoy launcher. Both ship with weapon-group settings (Warden: heavy guns manual, autocannons automatic within 1 km; Tempest: missiles manual, close defense automatic against drones first) |
| Fleet scenarios | Scenario 9 "Fleet action" (budget 2000, up to 4 ships) against a gun cruiser, a missile frigate and a PD picket; scenario 10 "Missile storm" (budget 2000, up to 3 ships) against two missile frigates and a PD picket. Test 7.2 now flies every reference ship with its own AI (no follow order), as the enemies are |

Still open (this doesn't block Milestone 1):
- Further balance passes: see the open items in [balance-pass-1.md](balance-pass-1.md).

---

## 15. Milestones

The detailed task breakdown and the tests for each milestone are in [implementation-plan.md](implementation-plan.md). That plan adds an M0 Foundation milestone before M1.

| # | Milestone | Done when |
|---|---|---|
| 1 | **Physics core** | A hardcoded ship flies with computed CoM and inertia, gimballed main engine, RCS, gyro, stabilization, and both speed-kill modes. It is drawn through the CSS theme layer, and the camera zooms. Headless tests pass |
| 2 | **Editor** | Polygon parts with edge snapping, free rotation, mirror mode, validation, live stats and overlays. Local library. Export/import bundles via file, clipboard and `SG1:` codes, with dependency collection and conflict handling. Test flight works |
| 3 | **Systems** | Networks, power priorities, fuel, ammo, heat and radiators running, with HUD readouts |
| 4 | **Combat** | Fixed and turret weapons, groups and modes, projectiles, beams, per-part damage, armor, inert wrecks, defeat conditions |
| 5 | **Missiles, PD, drones** | Guided missiles, automatic PD and flak, the 3 drone types with hangar |
| 6 | **AI** | Capabilities profile, utility behaviours, AI profiles, allied AI, Tab switching, allied orders |
| 7 | **Scenarios** | Arena with asteroids and boundary, 6–10 scenarios, objectives, result tracking. First balancing pass with the headless harness |

---

## 16. Future (post-prototype)

- Structural failure and splitting into independent bodies, using connection overlap as strength.
- Repairs: repair parts and drones.
- Target-relative speed kill. Optional flip-and-burn.
- Sensors and EW: detection range, lock time, jamming, heat and engine signatures, stealth.
- Custom drone designs in the editor.
- **In-game part editor:** draw outlines, mark edge types and set functional blocks, with sanity limits shown live. It produces `user:` parts that are already supported by export and import.
- Online design gallery or sharing service, built on the same bundle format.
- Full AI control for turret groups. Fleet orders.
- Per-part heat conduction.
- Campaign, unlocks and economy. AI that designs its own ships.
- Asynchronous design-vs-design multiplayer, then possibly real-time.
