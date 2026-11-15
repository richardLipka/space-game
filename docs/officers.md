# Officers

Ships carry officers. Each officer changes the ship's performance by a few percent through traits, and the
post the officer holds decides which traits count most.

## Posts by class

| Class | Posts |
| --- | --- |
| Drone | none |
| Fighter | pilot |
| Corvette, frigate | captain, tactical |
| Destroyer and larger | captain, tactical, navigation, engineering, operations |

Classes come from the ship's mass (`src/sim/ship/classes.ts`).

## Traits and effects

Every officer has **three positive and two negative traits** (`TRAITS` in `src/sim/crew/officers.ts`). A
trait adds a percentage to one or two stats: thrust, turning, gun damage, missile damage, point-defense
damage, rate of fire, accuracy, cooling and reactor output. Each trait has a **strength**: small (⅓ of the
listed effect), medium (⅔) or full. Random officers get all three strengths equally often; the roster and
the scenario crew dialog can set them.

The post emphasises the stats it works on:

| Post | Focus (×1.5) | Other stats |
| --- | --- | --- |
| Pilot | thrust, turning, gun damage, accuracy | ×1 (a pilot does everything) |
| Captain | — | ×0.8 on all |
| Tactical | gun, missile and point-defense damage, rate of fire, accuracy | ×0.5 |
| Navigation | thrust, turning | ×0.5 |
| Engineering | cooling, reactor output, rate of fire | ×0.5 |
| Operations | point-defense and missile damage, accuracy | ×0.5 |

Experience is level 1–5, shown as gold rank chevrons on the portrait. Each level above the first **trains
one stat** by 3 % (before post emphasis): raising the level adds one trained stat (the post's own stats are
three times as likely), lowering it removes the last one, and each can be changed in the roster. Officers
saved before training existed train their post's stats.
A ship's modifier for a stat is 1 + the sum of its officers' percentages, kept between 0.7 and 1.3.

Where the modifiers act:

- thrust and turning: force and torque applied to the ship (`World`)
- gun damage: projectile, burst and beam damage; point-defense damage: point-defense rounds
- missile damage: the warhead of missiles the ship launches
- rate of fire and accuracy: weapon interval and spread (`weaponPerformance`)
- cooling: heat shed by radiators and hull; reactor output: reactor maximum output

A ship without officers has every modifier at 1, so headless balance runs and the golden tests are unchanged.

## Roster

Crew (ship editor toolbar) opens the roster:

- pick a ship design; its posts (by class) each take an officer from the roster, with what they add and the
  ship's total
- **Generate crew for empty posts** or **Generate crews for every ship** create random officers
- edit officers: name (⟳ draws a new one in the officer's style), trained post, experience, traits (three
  positive, two negative), portrait, delete
- **Names**: the naming style of new officers (mixed, English, German, Japanese); **Import names…** loads
  your own name descriptor, **Default names** goes back to the bundled one
- **Export JSON** / **Import JSON**: the whole roster, or one officer to add

The roster is kept in the browser (`localStorage`, key `space-game.roster.v1`).

In a battle each ship's officers come from, in this order:

1. the crew set for that ship in the scenario (scenario editor → **Crew**, saved in the scenario file)
2. a crew the design carries (a ship file imported with its officers)
3. for your side (team 0): the roster's crew of the design (posts left empty stay empty)
4. for every other ship: random officers seeded by the battle and the ship, so a battle replays the same

## Crews in files

- **Ship files** (ship editor → Export) carry the design's crew from the roster as `crew`: a list of
  `{ "position": …, "officer": { … } }`. Importing such a file adds the officers to the roster at the
  design's posts (an officer whose id is taken by a different officer gets a new id).
- **Scenario files** carry each ship's crew the same way (`enemies[].crew`), set in the scenario editor's
  Crew dialog: generate officers with a naming style, a trait strength (or random) and a level (or random),
  copy a design's crew from the roster, edit one officer, or leave a ship random at the start.
- Officers that do not fit this version (unknown traits, too many traits, a bad level or portrait) are
  repaired when loaded, not rejected; see [save-load.md](save-load.md).

## JSON

Schema: `src/data/schemas/officer.ts`, validated by `validateRoster` and `validateOfficer`
(`src/data/validate.ts`).

```json
{
  "formatVersion": 1,
  "officers": [
    {
      "id": "officer-1",
      "name": "Ada Cogsworth",
      "position": "tactical",
      "level": 3,
      "traits": ["gunnery-expert", "steady-hand", "quick-loader", "nervous", "wasteful"],
      "portrait": {
        "head": 1, "skin": 2, "hair": 4, "hairColor": 3, "eyes": 2, "mouth": 1, "facialHair": 0,
        "neck": 2, "uniform": 1, "uniformColor": 0, "collar": 3, "accessory": 1, "suit": false
      }
    }
  ],
  "crews": { "fleet-sabre": { "tactical": "officer-1" } }
}
```

`crews` maps a design id to its posts and the officer holding each. `origin` (optional) is the naming style
the officer's name came from.

## Names

Names come from a descriptor file, `src/data/names/names.json` (schema `src/data/schemas/names.ts`,
validated by `validateNames`), with three styles: English, German and Japanese. Each style has:

- `id`, `label`, `weight` (share in mixed generation; English 2, the others 1)
- `order`: `given-family` (Ada Cogsworth) or `family-given` (Tanaka Hiroshi)
- `given` and `family` pools, each with
  - `names`: whole names to pick from
  - `parts` and `partChance`: syllable groups; with that chance a name is built from one piece of each group
    (Eisen + hauer, Yama + moto), never the same piece twice
  - `prefix` (optional): values and a chance, e.g. "von " for German family names

```json
{
  "formatVersion": 1,
  "styles": [
    {
      "id": "dwarvish",
      "label": "Dwarvish",
      "order": "given-family",
      "given": { "names": ["Borin"], "parts": [["Bor", "Dur", "Thra"], ["in", "ak", "ain"]], "partChance": 0.7 },
      "family": { "names": ["Ironfoot"], "prefix": { "values": ["son of "], "chance": 0.2 } }
    }
  ]
}
```

A descriptor imported in the roster is kept in the browser and replaces the bundled one for new officers and
for enemy crews.

## Portraits

`src/ui/portrait.ts` draws a face as SVG from the portrait indices: head shape, skin, hair or helmet (flight
helmet, top hat, brass helmet), hair colour, eyes (goggles, monocle, mechanical eye, spectacles), mouth,
moustache or beard, neckwear, uniform and its colour, collar and an accessory (epaulettes, cog medal,
headset, pipe, scar, brass gear, watch chain, cog earring). A space suit puts a helmet bubble round the
head. The portrait dialog (click a portrait in the roster) steps through each part, toggles the suit and
randomises. Every part has 7–15 options (`PART_LABELS`; `PORTRAIT_COUNTS` in `src/sim/crew/officers.ts`
holds the counts for random portraits).
