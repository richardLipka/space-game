# AI behaviour review

Every built-in AI profile (`src/data/ai/profiles.json`) was checked against what it is meant to do. Each one
flew three observed battles against a **weaker**, a **comparable** and a **stronger** enemy, and the harness
recorded what its ships actually did. The enemy is always the balanced AI.

```bash
npm run ai:observe                       # all profiles, 3 battles each
npm run ai:observe -- sniper kiter --seed 2
```

The harness (`src/headless/ai-observe.ts`) samples every half second:

- time per behaviour
- distance to the target over the range the behaviour aims for (range/R; 1 = on its planned range)
- speed, and whether the ship opens or closes on the nearest enemy
- the hull share at its first retreat
- time with missiles incoming
- for guards: the distance to the guarded ship, and the target's distance from it
- missile volleys, drone launch distance, formation spacing and passes

## Fleets

| Profiles | Own side | Weaker (cost) | Comparable | Stronger |
|---|---|---|---|---|
| balanced, aggressive, kiter, brawler, sniper, cautious, retreating, fleet-pass | Rapier, 2 × Wasp | Maul, Wasp (×0.53) | Rapier, 2 × Wasp (×1.0) | Anvil, Rapier (×2.0) |
| defensive | Viper (guarded, balanced AI), Rapier and Wasp guarding it | Rapier (×0.42) | 2 × Rapier, Wasp (×0.92) | Anvil, 2 × Rapier, Wasp (×1.63) |
| carrier | Ark | Maul, Wasp (×0.38) | Rapier, Maul, Wasp (×0.92) | Anvil, Rapier, Wasp (×1.54) |
| missile-wall | Viper, 2 × Maul | Rapier (×0.44) | Anvil, 2 × Wasp (×0.90) | Anvil, 2 × Rapier (×1.63) |

Start distance 6 km, open space, 6-minute limit.

## Intended behaviour, observation and changes

| Profile | Should | Observed before | Verdict and change |
|---|---|---|---|
| **balanced** | Fight at about 70 % of weapon range, broadside or face by armament, retreat below 25 % hull, fire at 20 % hit chance or better. | range/R 1.2–1.6, won against weaker, drew against comparable, lost against stronger. Burned its fuel within 3 minutes. | Behaves as meant. Fuel limit (all profiles, see below). |
| **aggressive** | Close fast (160 m/s), fight at 55 % range, fire at long odds, retreat only below 10 %. | Closed in and won against weaker and comparable, but ran at up to 300 m/s while chasing. | Mostly right. Top speed is now a real limit. |
| **kiter** | Hold long range (95 %), back off when enemies close in, orbit fast, retreat at 35 %. | Kept range (range/R 1.05), but fired only 16–24 % of the time. Drew against the weaker enemy with two ships lost. | **Wrong.** Its fire threshold (30 %) was above the hit chance at its own planned range. Lowered to 15 %. |
| **brawler** | Close to about 30 % of range and slug it out. | Mostly approaching (range/R 2–6): its 120 m/s rarely catches fighters. Won against weaker and comparable. | Acceptable. No change. |
| **sniper** | Sit far out (100 % range), move slowly (90 m/s), take good shots. | Fired 12–16 % of the time, drew against the weaker enemy with two ships lost, and chased fighters at 236 m/s. | **Wrong.** Its range is planned at a 20 % hit chance but it fired only at 40 %, so from its own range it never shot. Threshold now 20 %, and the speed limit holds. |
| **carrier** | Launch drones early and stay out of gun range. | Launched at 3.7–3.9 km as meant, then closed to about 1.1 km (minimum 35 m) and was destroyed. Gunless, it took the 1 km default range, and lost its drone-based range once the drones were out. | **Wrong.** A gunless ship with drone hangars now stands off at 60 % of its drone launch range (2.9 km), also after launching. |
| **defensive** | Stay with the guarded ship, engage only enemies within the guard radius (2.5 km), never chase beyond it. | Median distance to its charge 150–570 m, targets at most 2465 m from it. | Behaves as meant. No change. |
| **retreating** | Fall back at 20 m/s, guns on the threat, and fight once out of reach. | Withdrew at a median 13–46 m/s, opening the distance while firing. | Behaves as meant. No change. |
| **cautious** | Keep its distance (95 %), evade more, retreat at 30 %. | range/R about 1.0, won against weaker and comparable. | Behaves as meant. No change. |
| **fleet-pass** | Fly abreast at 150 m, pass the enemy at 300 m/s, come about 4 km beyond. | Passes happened, but fuel was gone in 140 s. A follower with no fuel left drifted off at 272 m/s, leaving 6 km gaps in the formation, and the comparable battle was a draw with nothing destroyed. | **Wrong (fuel).** The fuel limit throttles the passes as the tanks empty. Still the weakest doctrine against the standard AI, which docs/ai-types.md already notes. |
| **missile-wall** | Stand off at 85 % of missile range in a wall 300 m apart, and launch together every 12 s. | Only 44–65 % of volleys fired together, because a ship whose launchers were ready late fired alone. The Viper orbited on its own broadside instead of holding its place in the wall. | **Wrong.** Launches now happen only in the first second of a salvo window (else the ship waits for the next one), and missile-line ships hold their wall place instead of a broadside orbit. Over nine battles, salvo sync is now 63–100 % (median 76 %), up from 44–68 % (median 63 %). |

### Problems shared by every profile

- **Fuel.** Ships burned all their fuel in 2–4 minutes and then drifted. The AI now never asks for more speed
  than 40 % of the Δv it has left (at least 25 m/s): `AI_TUNING.fuelSpeedShare`, `speedLimit()` in
  `src/sim/ai/brain.ts`.
- **Top speed.** The profile's top speed limited only the speed relative to the target, so a heavy ship
  matched a fighter's 250 m/s. It now caps the requested speed in the world frame while fighting or
  repositioning. Evading, following a leader and doctrine manoeuvres are held only to the fuel limit.
- **Outmatched.** Against the stronger enemy every profile loses all its ships within 100–190 s. Retreat
  starts on hull damage, which comes too late against twice the firepower. This is left as it is: knowing
  when you are outgunned would be a new behaviour (for the cautious type in particular), not a fix.

## Found along the way: formations and flip-and-burn

The speed-kill e2e tests were flaky in CI. Following that up turned up two more faults:

- **Wingmen rammed their leader.** Follow slots were laid out along the leader's *heading*. A leader that
  flips to burn swings every slot through itself, so the wingmen flew through it. Heavy wingmen were also
  told to face the leader's nose and spun between that and their braking heading.
  - Slots now follow the leader's direction of travel (kept while it is slow), and are spaced by both
    ships' size.
  - Wingmen face along the formation.
  - AI steering avoids friendly ships on a collision course, using their actual motion, since a heavy ship
    still carries its speed while it turns to brake. Doctrine formations (fleet pass) keep their own
    spacing and skip this.
  - In the flight sandbox a wingman now disturbs the stopped leader in 1 of 21 stops, down from 8 of 21.
- **Flip-and-burn did not settle from low speed.** Turning with RCS also pushes the ship sideways. Below
  about 3 m/s that push was as large as what was left to kill, so the ship chased its own residual velocity
  for ever. That is why the tests stalled at 1.5 m/s. Below `FLIGHT.flipFinishSpeed` (3 m/s) it now
  finishes without turning, whenever its strongest axis still points within 90° of the way to brake.

## Before and after (seeds 1–3, 99 battles each)

Wins / draws / losses of the observed profile, with all changes in:

| Profile | Weaker | Comparable | Stronger | Firing time |
|---|---|---|---|---|
| kiter | 1/1/1 → 1/1/1 | 0/2/1 → **3/0/0** | 0/0/3 → 0/0/3 | 17–22 % → 37–51 % |
| sniper | 1/1/1 → **3/0/0** | 0/3/0 → 0/2/1 | 0/0/3 → 0/0/3 | 13–18 % → 23–40 % |
| fleet-pass | 1/2/0 → 2/1/0 | 1/2/0 → 0/2/1 | 0/1/2 → 0/0/3 | 27–33 % → 19–55 % |
| cautious | 3/0/0 → 2/1/0 | 1/1/1 → **3/0/0** | 0/0/3 → 0/0/3 | about the same |
| missile-wall | 3/0/0 → 3/0/0 | 0/1/2 → 0/2/1 | 0/1/2 → 0/0/3 | about the same; salvo sync median 63 % → 76 % |
| carrier | 2/1/0 → 1/2/0 | 0/0/3 → 0/0/3 | 0/0/3 → 0/0/3 | about the same |
| balanced, aggressive, brawler, defensive, retreating | unchanged against weaker | within one battle either way | unchanged | |

- **Totals:** 37 wins, 18 draws, 44 losses before; about 40 wins, 14 draws, 45 losses after. Fewer fights end
  undecided because ships no longer drift with empty tanks.
- **Noise:** the balanced reference enemy got the same fixes, so the comparable matchups compare two
  improved AIs. With three seeds, one battle either way is noise.
- **Stronger enemies still win every time.** See "Outmatched" above.

Checked by `test/sim/ai-behaviour.test.ts` (the speed and fuel limit, the carrier standoff, the salvo
window, follow slots through a flip, and an observed sniper and missile-wall battle) and by the speed-kill
e2e tests.
