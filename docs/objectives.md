# Objectives, jump points and strategy orders

Battles do not have to end with one side wiped out. A scenario can ask the player to escort a ship, hold a
zone or break out. Jump points let ships leave a battle alive, and in strategy mode the player can send
ships out, set what they fire at, and focus fire. Ships that get away are kept, not lost, which a campaign
can build on.

## Objectives

| Objective | Won when | Lost when |
|---|---|---|
| `destroyAll` | Every enemy ship (not drones) is destroyed or has jumped out. | — |
| `survive` | `seconds` have passed. | — |
| `protect` | The allied ship (`designId`, a team-0 `enemies` entry) outlives every enemy. | It is destroyed. |
| `escort` | That allied ship reaches `zone`. It flies there on its own. | It is destroyed. |
| `hold` | One of your ships has been inside `zone`, with no enemy ship in it, for `seconds` in all. Time lost while it is contested is not reset. | — |
| `breakout` | `count` of your ships (default: all) have left through the jump point `zone`. | Fewer ships are left than are needed. |

Whatever the objective, the battle is also lost in two cases:

- **Every player ship is gone.** The reason given is "Your fleet withdrew" if some of them got away, else
  "All your ships were defeated".
- **The optional `timeLimit` (seconds) passes** before the objective is met. `survive` is the exception: it
  is met by then.

The enemy reacts to the objective:

- **escort:** enemies fire at the escorted ship first whenever it is among their targets (focus fire).
- **hold:** enemies without orders hold the zone and fight whatever comes near.
- **breakout:** enemies without orders hold where they are placed, a blockade.

The objective's zone is drawn in amber, with an arc showing how much of a hold is done. Jump points are
drawn in green. The HUD and the strategy panel show progress, for example:

- **hold:** "hold Beacon · 34 / 60 s · contested"
- **escort:** "escort Mule to Haven gate (2140 m)"
- **breakout:** "1 / 3 out · jumping in 1.2 s"

Bundled scenarios using them:

- **s16 Convoy run (escort):** a hauler crosses the field, with raiders north and south of its route.
- **s17 Hold the beacon (hold):** three guards sit on the beacon.
- **s18 Breakout (breakout):** a cruiser, two snipers and two fighters hold the jump point; all three
  ships must get out.

Flown by the balanced AI, s16 and s18 are won in about 3 of 4 seeds, and s17 in all of them.

## Jump points

`arena.exits` lists jump points: `{ position, radius, label?, team? }`. Without `team`, every side can use
one. A ship leaves the battle once it has stayed inside a jump point it may use for `EXIT.dwell` (3 s):

- **Player-flown ships** always go through.
- **AI ships** go through only when they are getting away: escaping because they are out of ammunition or
  outgunned, or ordered to disengage. An AI ship that only passes through stays.

A ship that has jumped is out of play. It is not drawn, not hit and not targeted, and `world.hasShip` is
false for it. It is not destroyed: `ship.escaped` is set, and the report lists it as "jumped out".

AI ships that are escaping make for the nearest jump point they may use and stop in it. Without one, they
run away from the enemy as before ([ai-behaviour.md](ai-behaviour.md)).

The scenario editor has a **Jump point** tool. Click on the map to place one. Select it to set its radius,
name and which team may use it. The objective's zone is moved by dragging and sized the same way.

## Strategy orders

| Order | Key | What it does |
|---|---|---|
| Focus fire | F, then click an enemy | The selected ships fire at that enemy first whenever it is among their targets: score × 20 in target choice. They keep their orders, unlike Attack, which chases. Click open space to clear. |
| Disengage | R | Order `retreat`: escape at full speed (1.6 × the top speed, fuel permitting), through the nearest jump point if there is one, else away from the enemy. |
| Disengage all | Shift+R, or the bar button | Every ship disengages. |
| Rules of engagement | E cycles, or the "Fire" select | **Weapons free:** fire at will. **Return fire only:** fire only at ships that have hit your side (target choice also prefers them). **Hold fire:** no guns, beams, missiles or drones; point defense still fires. |

Focus-fire targets get a red cross-hair on the map. The ship list shows a ship's rules of engagement when
they are not "weapons free", and its focus target.

Code:

- `Order` `retreat`, `AiState.focus` and `AiState.roe` in `src/sim/ai/brain.ts`.
- Jump points: `World.exits`, `World.jumpOut()` and `EXIT` in `src/sim/world.ts`.
- Objectives: `updateBattle()` in `src/sim/scenario/battle.ts`.
- Tests: `test/sim/objectives.test.ts` and `e2e/objectives.spec.ts`.
