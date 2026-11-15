# AI types (skirmish)

The skirmish setup (Skirmish button in the editor) gives every ship a pilot: the player (side 1 only) or one of
four AI types. Each type is a full AI profile built from a base profile plus 3–5 parameters
(`src/data/ai/stances.ts`). The same types are registered as named profiles (`aggressive`, `defensive`,
`retreating`, `cautious`), so scenarios use them too. A defensive enemy names the ship it guards with `guard`
(and optionally `guardRadius`).

| Type | Behaviour | Parameters (default) |
|---|---|---|
| **Aggressive** | Closes in fast, fires at long odds and fights almost to the end. | Engage range (55 %), top speed (160 m/s), retreat below hull (10 %), fire threshold (10 %) |
| **Defensive** | Stays with a guarded ship (escort formation) and engages only enemies within the guard radius of it, ranked by distance to that ship; never chases beyond the radius. | Guarded ship, guard radius (2500 m), engage range (60 %), retreat below hull (15 %), fire threshold (15 %) |
| **Retreating** | Falls back from the nearest threat at its withdraw speed with its guns toward it, and keeps firing. Once out of reach (1.6 × its engage range) it stops and turns to fight whoever follows. | Withdraw speed (20 m/s), engage range (90 %), fire threshold (15 %) |
| **Cautious** | Keeps its distance, evades more and leaves early when hurt. | Engage range (95 %), top speed (140 m/s), retreat below hull (30 %), fire threshold (15 %) |

What the parameters mean:

- **Engage range:** the preferred distance, as a share of the weapons' effective range. Range is planned at a
  fixed 20 % hit probability, so this alone sets the distance.
- **Top speed:** the speed limit while closing in or repositioning.
- **Retreat below hull:** the hull share under which the ship falls back. A retreat is a fighting withdrawal
  at 60 % of top speed, so a healthy pursuer catches up.
- **Fire threshold:** the minimum estimated hit chance before a weapon fires.
- **Guard radius:** for defensive ships, the zone around the guarded ship.
- **Withdraw speed:** for retreating ships, the speed of the steady fallback.

## AI changes made with this work

- **Range planning.** The preferred range is planned at a fixed hit probability, so a picky shooter waits
  for good shots instead of closing in, and an eager one no longer stands further off.
- **Broadside range keeping.** The radial correction is capped by stopping distance, as approach is.
  Heavier ships overshot and oscillated without it.
- **Retreat is a fighting withdrawal.** Retreating ships fall back at 60 % of top speed with guns on the
  threat. Before, they fled at full speed and the pursuer could never catch up, so battles ended in
  10-minute chases.
- **Heat.** While cooling down above 90 % heat, the AI also holds its guns (PD keeps firing). Before, it
  kept firing and burned out its own command module.
- **Asteroids.** Avoidance also slows down along the path while steering around a rock, so heavier ships have
  time to swing clear.

## Study

`npm run ai:study` fights the symmetric scenarios' fleets (s11–s15) AI against AI. The study has two parts:

- **Matrix:** a whole side flies one type against a side flying another type. Every pair is played, and
  both orders are included.
- **Sweeps:** one parameter of one type is changed, and the variant fights the same type at its defaults,
  with sides swapped.

Scores count a win as 1 and a draw as ½. Fights are capped at 10 minutes.

<!-- study results are inserted below -->

### Results (catalogue v0-7, 2 seeds, 880 battles, about 2.3 h on 18 threads)

**Type against type.** Each cell is the row type's score against the column type, then the median fight
length and the share of timeouts. The diagonal is a type against itself.

| row \ column | aggressive | defensive | retreating | cautious |
|---|---|---|---|---|
| aggressive | 50 % · 484 s · 40 % | 55 % · 546 s · 50 % | 45 % · 526 s · 50 % | 55 % · 582 s · 70 % |
| defensive | 50 % · 579 s · 60 % | 60 % · 511 s · 80 % | 35 % · 565 s · 50 % | 35 % · 563 s · 50 % |
| retreating | 50 % · 581 s · 60 % | 45 % · 511 s · 50 % | 55 % · 578 s · 70 % | 55 % · 577 s · 90 % |
| cautious | 25 % · 540 s · 50 % | 45 % · 573 s · 70 % | 35 % · 537 s · 50 % | 45 % · 576 s · 70 % |

No type dominates: every score but one lies between 35 % and 55 %. The outlier is cautious, which lost
75 % against aggressive. With 10 battles per cell, a 10-point difference is noise.

**Sweeps.** Each value was played 12 times against the same type at its old defaults.

| type · parameter | result | new default |
|---|---|---|
| any · fire threshold | The clearest signal in the study. A threshold of 40–60 % loses badly (8–33 %): the ship waits for shots that never come. 5–25 % wins. | 10–15 % for every type (cautious was 30 %) |
| aggressive · engage range | 55 % is best (58 %, shortest fights). 20 % is worse: the ship takes the first hits while closing in. | 45 % → 55 % |
| aggressive · top speed | 180 m/s gave the fewest timeouts; 250 m/s overshoots. Faster ships also hit more asteroids in the avoidance test. | Unchanged (160 m/s) |
| cautious · engage range | 55 % won 71 %; 95 % is even and 100 %+ only sets up draws. 55 % would make cautious an aggressive ship. | 100 % → 95 %, still well beyond aggressive |
| defensive · guard radius | 2800 m won 58 % and halved timeouts. 300 m gives 92 % timeouts, because the escort never meets the enemy. | 1500 → 2500 m |
| retreating · withdraw speed | Slower is better: 5 m/s won 63 %, 45 m/s or more 33–42 %. | 30 → 20 m/s (still a withdrawal) |
| retreating · engage range | 55–95 % about even, 20 % and 130 % worse | 80 % → 90 % |
| any · retreat below hull | No effect up to 55 %; at 80 % slightly worse. Crippled ships are rarely fast enough for this to matter. | Unchanged, except cautious 40 % → 30 % |

**What this says about the game.**

- The mirror fleets (2–6 ships per side) fight long. The median is 8–10 minutes, and 40–90 % hit the
  10-minute limit, mostly with one side crippled but not destroyed.
- Duels of single ships stay at 1–5 minutes, the target for small fights (balance pass 2). Fleet battles
  are slower because ships spread fire, retreat and rotate.
- A further balance step should look at fleet battles: the end condition (a crippled ship that can't fight
  still counts) and repair of escorts. Weapon numbers should not change for this.
- Types that hold back (retreating, cautious) produce the most draws. The stall rule in `npm run tune` scores
  these by armor left.

## Fleet doctrines

Two AI profiles fly a whole side by a doctrine instead of each ship's behaviour scores alone
(`src/sim/ai/doctrine.ts`). They can be picked wherever an AI type is chosen: in the scenario editor, in
strategy mode, and in duels.

**Fleet pass** (`fleet-pass`, in the style of The Lost Fleet):

- **Formation:** the side's ships form up abreast of the leader, the lowest-numbered ship, 150 m apart. The
  leader slows, to 60 % of pass speed at 1 km off station, until the others have taken their slots.
- **The pass:** the leader flies at the enemy fleet's centre at the pass speed (300 m/s), aiming 400 m to
  one side of it. The fleets cross with a short, violent contact, and each ship turns its strongest side
  (its live attack front) to the nearest enemy while in reach.
- **Coming about:** past the enemy, the formation runs on until it is 4 km beyond the enemy centre, or
  until the time that would take has passed if it is being chased. It then comes about and makes its next
  pass on the other side.
- **Parameters:** `passSpeed`, `passOffset`, `passTurnDistance`, `formationSpacing`.

**Missile wall** (`missile-wall`, in the style of the Honorverse):

- **Standoff:** the side stands off at 85 % of its missile range (`standoffFactor`) in a line abreast
  across the bearing to the enemy (a wall of battle, `formationSpacing` 300 m).
- **Salvos:** it launches on a shared salvo clock (`salvoInterval` 12 s). Every ship fires in the same
  window, so the missiles arrive as one wave against the enemy's point defense.
- **Point defense:** stays active throughout.
- **Weakness:** heavy missile ships cannot outrun a fleet that charges straight in, so the doctrine is at
  its best in missile duels.

## AI duels (`npm run ai:duel`)

The duel harness pits two identical fleets against each other, one flown by AI parameter set A and one
by B. Each seed is fought twice, with A on each side, so neither gains from its spawn.

```bash
npm run ai:duel -- --a fleet-pass --b balanced --fleet fleet-rapier,fleet-viper,fleet-wasp --seeds 8
```

`--a` and `--b` take a profile id or a JSON file holding a full profile. Other options are `--distance`
(start distance, m), `--time` (limit, s), `--round` (fresh seeds) and `--threads`. The result line gives:

- wins, losses and draws for A
- ships each side lost per battle
- median fight length
- the share of time each side spent firing
- missiles launched, shot down and hit
- a score: A's win share (draws count half), plus a little for ships B lost rather than A

`--tune` hill-climbs A's parameters against a fixed B. It uses `--iterations`, `--params` (default: the
general parameters and those of A's doctrine, see `TUNABLE` in `src/headless/ai-duel.ts`) and `--seed`.
A candidate is accepted only when it beats the best so far and holds up on fresh seeds. The best profile is
written to `balance-report/ai-duel/<id>-tuned.json`. Use at least 10 seeds when tuning: with 3 seeds (6
battles) one lucky round swings the score by 0.3.

First results (8 seeds × 2 sides, 2026-11-15):

| Duel | Fleet | Score | A : B (draws) |
|---|---|---|---|
| fleet-pass vs balanced | Rapier, Viper, Wasp at 6 km | 0.64 | 6 : 2 (8) |
| fleet-pass vs aggressive | Rapier, Viper, Wasp at 6 km | 0.35 | 5 : 9 (2) |
| missile-wall vs balanced | Viper, Squall, Maul at 9 km | 0.36 | 1 : 5 (10) |
| missile-wall vs cautious | Viper, Squall, Maul at 9 km | 0.30 | 2 : 8 (6) |

In the missile-wall duels point defense shot down 84 % of all missiles, so the current balance does not
favour missile duels.
