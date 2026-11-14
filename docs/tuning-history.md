# Tuning history

GA runs and how their best sets compared with the game of the day on fresh seeds (seed rounds the run
never saw). Loss is the total from `npm run tuning -- eval --seeds 3 --round N`; lower is better. The run
folders under `balance-report/tuning/runs/` are not in git; this file keeps the numbers.

## Next run (prepared, not run)

```bash
npx tsx src/headless/tuning-cli.ts ga --run rules-heavy --config tuning/rules-heavy.json --hours 6.5 --generations 400 --patience 100
```

[`tuning/rules-heavy.json`](../tuning/rules-heavy.json) raises the weight of the balance rules from 2 to 20
and the runs per salvo test from 20 to 40. Everything else stays at the defaults (18 genes, 9 matchups,
activity terms, stop after 2 disabled ships).

- **Weight:** run 2 shows why. Two missed point-defense rules cost only 0.05 at weight 2, so the GA traded
  them for fight length. At weight 20 the same misses cost about 0.5, as much as a matchup far out of its
  band.
- **Runs:** 40 runs resolve the 10 % steps of the salvo rules better.

## Game changes since run 2 (not yet tuned)

Point defense deals 15 % of its damage to ships, missile warheads penetrate, ordinary turrets shoot at
missiles only in their last 1.5 s, and black hole cores destroy what enters them. The same seeds that gave
0.718 before (`eval --seeds 3`, round 0) now give 1.443:

- **Maul mirror:** shorter, median 25 s.
- **Rapier + Viper group:** shorter, 88 s.
- **Viper mirror:** stalls, all three battles time out with the Vipers firing 18 % of the time.

The prepared run (rules-heavy) starts from these values.

Teaching scenario s08 (mixed fleet) could no longer be won by its reference fleet, because the enemy
frigate's missiles are now decisive. It allows 4 ships and a budget of 800, and the reference fleet adds the
missile-and-point-defense archetype, which wins 6 of 20 seeds.

## Run 2: activity-6h (2026-11-14, from e9ff1b4)

The first run with the activity, manoeuvring and passive-ship terms, the 2-disabled-ship stop and the
balance rules (weight 2). 117 generations in 6.5 h. **Not applied:** it is better on average but not in
every round, and it breaks two point-defense rules.

| Seed round | Game (e9ff1b4) | Run 2 best |
|---|---|---|
| 31 | 1.203 | 1.037 |
| 32 | 1.025 | 1.228 |
| 33 | 1.622 | 0.586 |
| 34 | 1.029 | 1.065 |
| **Mean** | **1.220** | **0.979** |

Run 2 best, median fight length per round (s), and the rules it broke:

| Matchup | Band | R31 | R32 | R33 | R34 |
|---|---|---|---|---|---|
| small-wasp | 15–60 | 69 | 36 | 46 | 41 |
| small-spark | 15–60 | 210 (t/o) | 210 (t/o) | 210 (t/o) | 210 (t/o) |
| small-group | 30–90 | 33 | 30 | 34 | 30 |
| medium-maul | 45–150 | 61 | 126 | 113 | 106 |
| medium-needle | 45–150 | 72 | 390 (t/o) | 78 | 57 |
| large-rapier | 180–300 | 100 | 80 | 178 | 91 |
| large-viper | 180–300 | 600 (t/o) | 144 | 242 | 600 (t/o) |
| large-anvil | 180–300 | 280 | 240 | 223 | 368 |
| large-group | 180–300 | 147 | 600 (t/o) | 210 | 174 |

- **Rules broken in every round:** of 2 missiles against 1 gatling, one gets through in 5 % of runs
  (needs 10–80 %); of 3 against 2 gatlings, none ever gets through.
- **Activity:** ships fired 32–83 % of their alive time and manoeuvred 33–92 %. The low ends are the Viper
  stalemates.

What the best set changed (game value → run 2):

| Gene | Change | Gene | Change |
|---|---|---|---|
| pace | 2.07 → 1.71 | rangePrice | 0.43 → 0.77 |
| hpArmor | 2.14 → 7.88 | calibre | 0.027 → −0.054 |
| hpCommand | 3.05 → 2.94 | supply | 0.95 → 1.19 |
| hpWeapon | 3.70 → 5.10 | radiator | 1.89 → 3.16 |
| hpSystems | 1.46 → 1.39 | hullHeat | 0.0088 → 0.0098 |
| armorStop | 0.19 → 0.096 | fuelHeat | 7142 → 13725 |
| beam | 0.21 → 0.23 | muzzleHeat | 0.0069 → 0.0032 |
| missile | 1.04 → 0.75 | fireTime | 144 → 123 |
| pd | 3.23 → 2.22 | missileHp | 0.0029 → 0.0013 |

## Run 1: six-hours (2026-11-13/14, from 1c645e3)

Fight length only (no activity terms, no balance rules), 4 groups stop at their time limit. 144
generations in 6.6 h. **Applied** in 1da57c5, then missile HP raised by hand to keep the salvo rule.

| Seed round | Game (1c645e3) | Run 1 best | Applied, after the missile HP fix |
|---|---|---|---|
| 21 | 1.316 | 0.696 | 0.682 |
| 22 | 1.082 | 0.684 | 1.007 |
| 23 | 1.653 | 0.637 | 1.035 |
| 24 | 1.724 | 0.641 | 1.097 |
| **Mean** | **1.444** | **0.665** | **0.955** |

Run 1 best beat the game in every round. Making missiles hard enough for the salvo rule gave back part of
the gain, through erratic medium missile fights. Run 1 changed pace 4.66 → 2.07, missile 1.85 → 1.04,
pd 1.52 → 3.23, rangePrice 0 → 0.43, hpWeapon 1.67 → 3.70 and hpCommand 5.93 → 3.05, among others; the
values are in `src/data/balance/model.ts` since 1da57c5.

## Problems no run has fixed

- **Spark mirror:** runs to the time limit in almost every battle (stalemates, running out of ammunition,
  40–60 % brownout). This looks like a design or AI problem, not a balance rate.
- **Rapier mirror:** too short, 80–180 s against 180–300 s.
- **Viper mirror:** stalls at the time limit in about half the rounds.
