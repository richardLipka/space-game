# After-action report and replays

Every scenario, skirmish and strategy battle is recorded. When it ends, the results panel (or the strategy
banner) offers **Report** and **Watch replay**. The editor's **Replays** button lists the newest 20
recordings kept in this browser. From that list you can:

- watch a recording again
- read its report
- save it as a `.replay.json` file
- load a recording from a file
- delete it

A battle left before it ends is recorded too, marked "left early".

## The report

`BattleLog` in `src/sim/scenario/report.ts` keeps the report up to date. It only reads the world, so the
same report comes out of a live battle, a headless run and a replay.

- **Hull left over time:** each side's hull as a share of what it started with, sampled every 2 s. Marks
  show ships lost or gone.
- **Per ship:**
  - hull left
  - damage dealt to the other side (friendly fire not counted) and taken
  - kills
  - gunnery: gun rounds fired and the share that hit a ship (not point defense)
  - fuel and ammunition left
  - outcome: destroyed (when, and by whom), jumped out, retreating, disabled or still fighting
  - for AI ships, the share of time per behaviour (for example "broadside 41 %, approach 31 %, evade 28 %")
- **Timeline:**
  - ships destroyed (and by whom)
  - ships that jumped out
  - the first retreat of each ship
  - ships with nothing left to fire
  - objective events: zone taken, halfway held, the end

Kill credit goes to the ship that last damaged the victim, from `combat.dealtTo` (hull damage by attacker
and target; drones credit their carrier). Impacts and black holes show as "collision".

## Replays

The simulation is deterministic (spec §13.4). A replay therefore needs only:

- the battle's set-up: scenario, fleet, designs, drone designs, AI profiles, flight model and crews
- what the player changed during the battle

Rebuilding the world from the set-up and applying the same changes on the same ticks gives the same battle.

**How the changes are recorded.** `BattleRecorder` in `src/sim/scenario/record.ts` does not hook every
control. Instead, around each world step it takes every ship's *control state*:

- intent and weapon command
- weapon group modes and point defense
- ejections waiting and hangar launches waiting
- power priority, missile and drone type, drive mode, radiators
- the AI: profile, order, queue, focus, rules of engagement

The state just after a step and the state just before the next step differ only by what the player did in
between. Those differences are recorded, with the tick, and `ReplayPlayer` applies them before the same
tick's step.

**Checking a replay stays exact.**

- **World hash:** every 5 s the recording keeps a hash of the world. When a replay's hash differs, the
  flight view says from when it no longer matches. That happens when the game has changed since the
  recording, or when something changed the world outside the known controls (debug hooks, for example).
- **Negative zero:** JSON loses it, and the simulation can tell it from 0, so recordings are written with
  `toJson`/`fromJson`, which keep it.

**Size.** A hand-flown five-minute battle is about a megabyte, because the pilot's aim changes every tick. A
strategy battle is a few kilobytes. Recordings are kept in IndexedDB (`space-game-replays`). Without
IndexedDB (private windows) they are kept in memory until the page closes.

Watching a replay uses the flight view's watch mode: Tab follows the next ship, and the time scale and pause
work. The replay stops where the recording ends.

Tests:

- `test/sim/replay.test.ts`:
  - a battle with hand flying, AI orders, a profile change, focus fire and rules of engagement replays to
    the same world hash and the same report
  - a recording survives a JSON round trip
  - a damaged recording is noticed
- `e2e/objectives.spec.ts`: records a battle and opens its report and replay.
