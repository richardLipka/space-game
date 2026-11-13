# Tuning by fight length

`npm run tuning` tunes the [balance model](balance-model.md) by how long fights between identical ships
last. Small ships should settle a fight quickly and brutally; two large ships should fight for three to five
minutes. The tool fights mirror matchups headless, compares the fight lengths with a target band per
matchup, and changes the model's parameters to bring them into their bands.

It works in two modes:

- **Steps** (`eval`, `sensitivity`, `history`): one measurement at a time, read by a person or an AI agent
  who decides the next values. Use this to understand a problem and to make deliberate changes.
- **Genetic algorithm** (`ga`): runs unattended for hours and saves its state after every generation. Use
  this to search many parameters at once once the matchups and ranges are right.

`apply` writes accepted parameters into `src/data/balance/model.ts` and the catalogue.

In PowerShell, `npm run tuning -- ga --run x` loses its flags (the npm wrapper drops `--`). Quote it as
`npm run tuning '--' ga --run x`, or run `npx tsx src/headless/tuning-cli.ts ga --run x`. The tool refuses
to start when it sees bare words where flags should be.

Code: `src/headless/tuning/` (genome, config, fitness, ga, apply, report) and `src/headless/tuning-cli.ts`.
Output goes to `balance-report/tuning/` (not committed).

## What is measured

A **matchup** is two sides of ships flown by the same AI type (aggressive by default). The defaults are
mirror fights of the fleet designs:

| Matchup | Ships per side | Band (s) | Target (s) |
|---|---|---|---|
| small-wasp, small-spark | 1 wasp / 1 spark | 15–60 | 30 |
| small-group | 2 wasps + 1 spark | 30–90 | 50 |
| medium-maul, medium-needle | 1 maul / 1 needle | 45–150 | 90 |
| large-rapier, large-viper, large-anvil | 1 of each | 180–300 | 240 |
| large-group | rapier + viper | 180–300 | 240 |

The **fight length** is the time from the first hit to the end. Each matchup is fought `seeds` times (4 by
default). Every ship's spawn point is moved up to 300 m and its heading up to 25°, by a random amount fixed
by the seed. Without this jitter a mirror fight is so symmetric that both ships take the same damage at
the same moment.

A battle stops early when:

- Its time limit runs out: 90 s to close in plus twice the band's upper end, at most 600 s. It counts as a
  timeout and as that long.
- Nobody can fight any more (`timeout-disarmed` or `timeout-out-of-ammo`). Ships that can still fly are not
  defeated (spec §8.1), so such a battle would otherwise run out the clock.

## The loss

One number per parameter set; lower is better and 0 means every matchup is on target. Per matchup, with
`m` the median length:

- **length**: `e² + centre·c²`, where `e` is how far `m` is outside the band in log units (0 inside it), and
  `c = ln(m / target)` pulls it toward the target inside the band.
- **timeouts**: `timeouts × max(0, timeout share − allowedTimeouts)`.
- **ammoOut**: `ammoOut × share of battles ending with nobody able to fire for lack of ammunition`.
- **spread**: `spread × max(0, IQR/median − allowedSpread)`. Fights of the same ships should not swing
  between a 10 s alpha strike and a 5-minute brawl.

The terms are weighted by each matchup's `weight` and averaged. **drift** adds
`drift × Σ (gene position − start position)²` so the search does not wander from the current values
without reason. All weights are in `loss` in the config.

## Parameters (genes)

A gene is one tuned number with a range; the DNA is each gene's position in its range, a number in
[0, 1], on a log scale for `log` genes. Targets:

- `balance:<path>`: a number in the model table, e.g. `balance:heat.perKgFuel`.
- `balance:<path>.*`: a factor on every number under the path, e.g. `balance:hp.*` scales the HP of every
  component class. It applies after genes that set values inside the same path.
- `overlay:<section>.<key>.<field>`: a factor in the balance overlay, for numbers the model does not derive.
  Weapon damage, e.g. `overlay:weapons.core:weapon.laser.turret.s.damage`.

Default genes: overall HP, armor, command and weapon HP, smart-missile warhead factor, magazine fire time,
engine and gun heat, radiator capacity, hull radiation, reactor output, and damage factors for the laser,
the two autocannons and the medium cannon. `npm run tuning -- report` lists them with their ranges.

Hull radiation (`heat.hullPerMetre`) is read by the simulation at run time; a tuning battle sets it for its
own run and restores it afterwards.

## Step mode

```bash
npm run tuning -- eval --note "baseline"
```

```bash
npm run tuning -- eval --set hp=1.4,missileFactor=5 --note "slower pace, weaker missiles"
```

`eval` prints one row per matchup: band, median (↑ too long, ↓ too short), every fight's length, timeouts,
time spent hot and browned out, ammunition left, missiles launched/shot down/hit, and how the fights ended.
Every eval is appended to `steps.jsonl`; `history` lists them with what changed. `--params file.json` reads
values from a file: `last-eval.json`, a GA run's `best.json`, or plain `{ "hp": 1.4 }`.

```bash
npm run tuning -- sensitivity --genes hp,hpWeapon,missileFactor --seeds 3
```

`sensitivity` measures each gene a step below and above its value (×/÷ `--factor`, default 1.5) on the same
seeds. It prints the elasticity of each matchup's median length (d ln length / d ln value) and the loss at
both ends. It shows which knob moves which fights, and which ones do nothing.

`--round N` uses seeds `N·1000 + 1 …`, a fresh set of battles to check that a step was not a lucky draw.

A typical step loop for an agent: `eval` → read the table and the end reasons → change one or two genes →
`eval` again → on a promising result, `eval --round 1` to confirm → `apply` or hand the values to a GA run as
`--params` to refine.

## GA mode

```bash
npm run tuning -- ga --run night1 --hours 8
```

- Population 16 (`--population`), 3 seeds per matchup (`--seeds`), so about 430 battles per generation.
  On 18 threads one generation takes roughly 5–15 minutes, depending on how long the fights are.
- The first individual is the start values (current game, or `--params`); half of the rest are close
  mutations of it and half spread wider.
- Selection: elitism (3) plus tournaments of 3. Children are made by blend crossover (BLX-0.3) and Gaussian
  mutation, whose σ falls from 0.12 to 0.03 of the range. One random immigrant per generation.
- Every generation uses new seeds. Elites carry over and are measured again, so their score is an average
  over more battles; the run's best needs at least two measurements.
- Stops at `--hours`, `--generations`, or after `--patience` (15) generations without improvement. Ctrl+C
  stops after the current generation.
- `balance-report/tuning/runs/<run>/` holds:
  - `state.json`, saved after every generation; `--resume` continues from it.
  - `config.json`, the config frozen at the start.
  - `log.jsonl`, the whole population per generation.
  - `best.json`, the best parameters.
  - `report.html`, the loss curve, the best's fight lengths and parameters, and the population.
- The same `--seed` and config give the same run.

```bash
npm run tuning -- ga --run night1 --resume --hours 4
```

```bash
npm run tuning -- report --run night1
```

## Accepting a result

```bash
npm run tuning -- apply --run night1
```

`--params file.json` works in place of `--run`. This rewrites the changed numbers in `model.ts`, keeping
comments and layout, with 4 significant digits. It then derives the catalogue from the new table, applies
the overlay factors to weapon damage, and formats both files. Then:

```bash
npm run golden:update
```

```bash
npm run check
```

Tests that pin balance numbers may need updating. Overlay factors on numbers the model derives (global or
per-category HP) cannot be applied, because the next derive would undo them; tune those with `balance:`
genes.

## Custom configs

`--config tuning.json` takes the shape of `TuningConfig` (`src/headless/tuning/config.ts`). `genes` and
`matchups` replace the default lists, and `loss` merges with the default weights. `--matchups a,b` runs a
subset. A matchup may set `pilot` (AI type), `distance`, `limit`, `jitter` and `weight`. Sides need not be
mirrors, so a config can also hold cross matchups.
