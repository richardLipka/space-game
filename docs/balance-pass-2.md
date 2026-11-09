# Balance pass 2 (M7): fight length (applied, catalogue v0-6)

Goal: ship combat should last 1–5 minutes. Before this pass, archetype duels and scenario wins took
9–75 s (median engagement about 14 s).

## Tools

| Command | What it does |
|---|---|
| `npm run tune` | Automated tuning loop (below). Writes `balance-report/tune/`: `iteration-NN.json`, `overlay.json`, `catalogue.tuned.json`, `diff.txt`, `report.html`. `--apply` writes the tuned catalogue to `src/data/core/catalogue.json` (then run `npm run golden:update`). |
| `npm run balance:scenarios` | Every scenario fought AI against AI with its suggested fleet; fight-length histogram and end reasons (`balance-report/scenarios/`). `--overlay` tries an overlay. |
| Watch AI battle (scenario panel) | Watch the same battle in the app; Tab follows the next ship, +/− set the time scale up to ×8. |

Battles run in parallel worker threads (cores − 2), with results identical to a serial run. One iteration
covers 28 archetype pairings and 9 scenarios × 4 seeds (148 battles) and takes about 4 minutes on 18
threads.

**Engagement** is measured from the first hull damage to the end of the battle. A battle ended by its own
first hit counts with its full length.

### Tuning rules (`src/headless/tune.ts`)

All adjustments go into a **balance overlay** of multipliers (`src/data/balance/overlay.ts`); the catalogue
itself is changed only by `--apply`.

1. **Pace.** When the median engagement is more than 15 % off the 150 s target:
   - HP of every part × (target / median)^0.8;
   - ammunition follows HP; fuel follows its square root.
   - Ammunition and fuel are **mass-neutral**: magazines hold more rounds that weigh proportionally less, and
     more fuel means a proportionally higher specific impulse (same thrust, slower burn). A first run that
     simply enlarged magazines and tanks made ships 1.3–3.2× heavier and sluggish.
2. **Weapons.** When a weapon type's duel win rate is outside 35–65 % and its 95 % Wilson interval excludes
   50 %: damage × (0.5 / rate)^0.3, at most ±15 % per step and ±50 % in total.
3. **Energy.** A powered weapon throttled (hot or browned out) more than 30 % of the time gets power and heat
   × 0.9; one throttled under 2 % gets × 1.05.
4. **Elements.**
   - Command HP × 1.15 when more than 60 % of decided battles end with the command module destroyed.
   - Armor HP × 0.9 when more than 5 % of battles stalemate.
5. **Ammunition** × 1.25 when more than 10 % of battles end with everyone out of ammunition.

**Stopping.** The loop stops when all targets are met: median engagement 60–300 s, win rates 35–65 %,
timeouts ≤ 10 %, out of ammunition ≤ 10 %. It also stops when it stalls (targets missed, but no rule
applies).

## Result (applied as catalogue v0-6)

The first run (magazines and tanks simply enlarged) reached a 136 s median, but ships became 1.3–3.2×
heavier. With mass-neutral ammunition and fuel the ships keep their handling, so the overlay was re-tuned
(6 iterations from the first result, 4 seeds, about 7 minutes):

| | Before | After |
|---|---|---|
| Median engagement (all battles) | 14 s | **162 s** (duels 162 s, scenarios 157 s) |
| Weapon-type win rates | 29–71 % | 34–63 % |
| Timeouts (600 s limit) | 0 % | 13 % (stalemate 11 %, retreat 3 %, out of ammo 1 %) |
| Command-module kills | 30 % | 17 % |

Applied overlay (`balance-report/tune-final/overlay.json`, 71 catalogue values):

| Knob | Factor | Example |
|---|---|---|
| HP of every part | × 5.4 | Command module 800 → 4326, hull square M 240 → 1298 |
| Ammunition | × 5.4, mass-neutral | Missile magazine 4 → 22 missiles (16.4 kg each instead of 90); cannon 4 → 22 rounds |
| Fuel | × 2.3, as specific impulse | Large engine Isp 340 → 791; tank sizes unchanged |
| Heavy cannon turret damage | × 1.5 (guardrail) | Won 23 % of its duels |
| Lance damage | × 1.15 | Won 29 % |
| Laser turret damage | × 0.85 | Won 86 % |
| Autocannon turret damage | × 0.91 | Won 68 % |
| Armor HP | × 0.5 (guardrail; net × 2.7) | Stalemates |

Scenario wins with the AI flying the suggested fleet (4 seeds): s04, s05, s06, s07, s09 4/4; s02, s03 2/4;
s08 1/4; s10 0/4 (s10 runs 389 s). Every scenario still has a winning seed in the 20-seed test (7.2).

**Heat now matters much more.** Fights last about 5× longer, while heat per shot and per second of thrust
is unchanged. Ships that generate more heat than their radiators shed overheat in long fights, and overheat
damages heat producers, including the command module's built-in reactor. Attack drones also shred exposed
radiators. Heavy kinetic ships need radiators and heat sinks (the new fleet has them).

Tests whose time limits assumed the old pace now use the new one: the gunboat mirror (6.11) gets 600 s,
and asteroid avoidance (6.9) allows one more borderline seed.

## What the numbers cannot fix (needs a decision)

- **Stalemates (11 %)**, mostly with Bulwark (armored autocannon) and in laser and lance vs missile duels.
  Halving armor HP (the guardrail) barely changed them. These ships keep firing without killing,
  so the cause is damage reduction per hit (armor value) or AI range keeping, not HP. Options:
  - an armor-value knob for the tuner;
  - letting the AI close in once it has done little damage for a long time.
- **Retreats (3 %)**: missile and carrier ships retreat when out of missiles or drones, and the gun ship
  doesn't chase them.
- **Ammunition × 5.4 also multiplies internal magazines and missile counts** (22 missiles per magazine).
- **The AI's "cool" behaviour holds only beams.** A ship at 120–140 % heat keeps firing its guns, PD and
  autocannons, and slowly burns out its command module. Holding kinetic fire above about 95 % heat
  would fix it.
- **s10 (missile storm)** isn't won by the AI fleet in 4 seeds and runs long (389 s).

## Follow-up (catalogue v0-7)

- **Agility.** With one large engine (400 kN, 1.4 t) and light hull plates (40 kg/m²), destroyers
  accelerated at 29–36 m/s², faster than most fighters, and the battleship at 19 m/s².
  - Changes: large engine 250 kN and 2 t; hull plates 60 kg/m²; heavy cannon turret 1.1 → 1.5 t; fixed
    cannon 0.7 → 0.9 t; Leviathan has one large engine.
  - Now: fighters 14–33 m/s², gunboats about 10, destroyers 16–20, cruisers 9–13, battleship about 5.
- **Lasers** were too strong: turret damage −25 % and heat +50 %; lance damage −10 % and heat +30 %.
- **Radiators** need 1 m clear in front of each radiating face. The fleet's radiators are now spaced fins.
- **Tests that assumed the old pace now use the 1–5 minute pace:**
  - a stationary-target kill gets 150 s;
  - a scenario must be won within 400 s;
  - the gunboat mirror must end within 10 minutes in at least 80 % of battles. The rest are ships that
    lost their engines and can't follow a retreating enemy.
- **s08's suggested fleet** is now Hornet, Ram and Mortar (autocannon, fixed cannon, heavy turret).
