# Saving and loading

Everything the game saves, where it lives, and what happens when a file or stored value does not fit this
version: written by a newer version, naming parts, designs, AI types or traits this version lacks, or simply
damaged. The rule throughout: **load as much as possible, say what was left out, never crash and never
overwrite what could not be read.**

## What is saved

| Data | Where | Format / schema | Written by |
| --- | --- | --- | --- |
| Ship designs | browser library (IndexedDB) | `src/data/schemas/design.ts` | ship editor Save, imports |
| User parts | browser library (IndexedDB) | `src/data/schemas/part.ts` | part imports |
| Ship files, share codes | file / clipboard | bundle `src/data/share/bundle.ts` (designs, used parts, core hashes, crew) | ship editor Export |
| Officer roster | `localStorage` `space-game.roster.v1` | `src/data/schemas/officer.ts` | roster dialog |
| Name descriptor (imported) | `localStorage` `space-game.names.v1` | `src/data/schemas/names.ts` | roster dialog |
| Scenarios | `localStorage` `space-game.scenarios.v1`, JSON files | `src/data/schemas/scenario.ts` (incl. crews, flight model) | scenario editor Save / Export |
| Scenario results | `localStorage` | `src/ui/results.ts` | after each scenario battle |
| Skirmish setup | `localStorage` | `SkirmishSetup` (`src/sim/scenario/skirmish.ts`) | skirmish dialog |
| Preferences | `localStorage` (flight model, last design, editor view settings) | plain values | as used |

Every file format has a `formatVersion`.

## How each loader copes

### Unknown properties (a newer file)

Ship files, scenario files and rosters may hold settings a newer version added. `lenient()`
(`src/data/repair.ts`) validates strictly first; if the only problem is properties this version does not
know, they are dropped and the file loads, with a warning that lists them. A bundle with a higher
`formatVersion` than this version reads is refused with a clear message (its meaning may have changed).

### Parts this version lacks

`resolveDesign()` (`src/sim/ship/resolve.ts`) leaves placements of unknown parts out of a design.

- **Ship import:** core parts from a newer version are left out and named in the import preview (before,
  the whole file was refused). A ship made of nothing but unknown parts cannot be imported.
- **Library, editor:** a stored design with unknown parts opens without them, with a warning; one with no
  known part does not open. The design opened last falls back to the starter fighter if it cannot be built.
- **Battles:** every ship is built through `World.addShip`, which resolves the design, so the simulation
  never meets an unknown part.
- **Stored user parts** that this version cannot read are skipped at start-up (with a warning) instead of
  stopping the game from loading.

### Designs and AI types a scenario names

`startBattle()` no longer throws:

- an unknown design: that ship is left out
- an unknown AI profile: the ship flies as the balanced AI
- a protect objective whose ship is missing: the goal becomes destroying every enemy

Each becomes a warning, shown when the battle starts. The scenario editor still lists these as problems,
so they can be fixed there. Skirmish setups stored by another version keep their ships. Unknown pilot types
fly as aggressive AI, broken entries are dropped, and unknown designs are reported by the skirmish dialog.

### Officers, crews and rosters

`repairOfficer()`, `repairCrew()` and `repairRoster()` (`src/data/repair.ts`) rebuild officers field by
field:

- unknown or duplicate traits are replaced by random ones of the same kind (three positive, two negative)
- levels are clamped to 1–5 and the trained stats are fitted to the level
- unknown posts are dropped, bad portrait parts are drawn at random, a missing name is generated
- posts that name an officer the roster does not have are dropped
- portraits from before layout 2 (no `v`) get their monocle, eyepatch or cigar moved to the accessories

The stored roster is repaired on load (one bad officer no longer empties the roster), and so are imported
rosters, single officers, and crews in ship and scenario files. Crews are taken out of a file before it is
validated and repaired on their own, so an officer never stops a ship or scenario from loading. An imported
name descriptor that does not validate is refused, and the bundled one stays in use.

### Saved scenarios

Saved scenarios are read tolerantly. An entry this version cannot read at all is left out of the list but
**kept** in storage. Saving another scenario no longer deletes it, so a newer version can still open it.

### Other stored values

The skirmish setup, scenario results, preferences and the name descriptor each fall back to defaults when
they cannot be read. Scenario results entries that are not results are skipped.

## Checked by

- `test/data/loading.test.ts`: officer, roster and crew repair, crew adoption, unknown parts, scenarios
  with unknown designs, AI and protect targets, newer scenario files, and scenario crews and flight model
- `test/data/share.test.ts`: ship import with missing core parts, newer settings, and crews in ship files
