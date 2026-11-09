# Balance pass 1 (M7)

Run with `npm run balance -- --seeds 8 --limit 90`: eight equal-cost archetypes in
`src/data/designs/balance/`, each built around one weapon type on the same chassis, fought AI against AI
(balanced profile on both sides). Every pairing plays 8 battles; start side and id order alternate per seed.
The full report (heatmap, damage by weapon, checks) is written to `balance-report/report.html`.

## Result

| Archetype | Main weapon | Cost | Before (2 seeds) | After (8 seeds) |
|---|---|---|---|---|
| Hive | attack drones + PD | 220 | 14 % | 66 % |
| Volley | missiles + PD | 234 | 100 % | 60 % |
| Spear | laser lance | 228 | 71 % | 55 % |
| Hornet | autocannon turrets | 180 | 64 % | 54 % |
| Ram | fixed kinetic cannon | 196 | 50 % | 51 % |
| Glare | laser turrets | 208 | 32 % | 47 % |
| Mortar | heavy cannon turret | 173 | 32 % | 37 % |
| Bulwark | armored autocannon | 212 | 36 % | 30 % |

Checks: no dominant part (7.6), every weapon type wins against at least one archetype and loses against at
least one (7.7), every overall win rate within 20–80 %.

## Changes

| Part | Change | Why |
|---|---|---|
| Command module | HP 300 → 800 | One cannon shot or missile ended every fight |
| Missile | damage 600 → 300, blast radius 15 → 6 m, launcher reload 1 → 2 s, launcher cost 40 → 55 | A blast hits every part in range, so radius mattered more than damage; missiles won from beyond gun range |
| Missile magazine | capacity 6 → 4, cost 10 → 20 | Missile count per credit |
| Hangars | cost 30 → 120 (attack), 30 → 110 (PD), 12 → 60 (decoy) | Drones were free; a hangar now pays for the drones it holds |
| Drone core / gun | HP 60 → 120; gun damage 12 → 16, 80 → 150 rounds | Drones died at once and ran dry before a kill |
| Laser turret | power 300 → 200 kW, heat 250 → 100 kW, DPS 120 → 140 | Two turrets wanted more power than a reactor gives and overheated in seconds |
| Laser lance | DPS 420 → 360 | Strongest per credit |
| Fixed cannon | fire interval 2.5 → 2.0 s | Lagged behind turrets once the command module got sturdier |
| Heavy cannon turret | fire interval 3 → 1.8 s, traverse 35 → 45 °/s | Too slow to land hits |

Behaviour changes found by the harness:

- **Turret missile defense**: turrets in AI mode now shoot at missiles homing on their own ship when impact
  is less than 4 s away (spec §9.5 lets any round down a missile). Without it, only PD could answer missiles.
- **Missile volleys**: a volley no longer waits for launchers that have run out of rounds.

## Later changes

- Missile launchers and hangars now take 10 s between launches (decision log: Launch reload). The win rates above were measured before that change.

## Open items

- Laser-vs-laser and carrier-vs-carrier mirrors rarely finish within 90 s: laser ships heat each other into
  holding fire, carriers run out of drones. Mirror matches decided overall: 67 %.
- Bulwark (armor) is the weakest archetype: armor slows it and broadside AI exposes its unarmored side.
- Volley still edges out the rest per battle (12 s time to kill); it is also the most expensive archetype.
