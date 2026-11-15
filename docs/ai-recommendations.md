# Which AI for which ship

Every AI profile flew a **small**, a **medium** and a **large** ship, each against the balanced AI in three
setups, for 9 battles per profile:

- **Weaker:** the same ship at half hull.
- **Comparable:** an equal copy.
- **Stronger:** two copies.

Every profile also flew a missile ship (Viper) and a carrier (Ark) in the same three setups. The aim was to
keep each AI recognisably different, not to make all of them the best.

```bash
npm run ai:ships                                      # 9 battles per profile
npm run ai:ships -- kiter --extra fleet-viper,fleet-ark
```

Ships:

- **Gun AIs:** Wasp (fighter), Rapier (destroyer), Anvil (cruiser).
- **missile-wall:** Maul, Viper, Squall.
- **carrier:** Wasp, Ark, Anvil.

Seed 1, 5-minute limit, start 6 km apart. The harness is `src/headless/ai-ships-cli.ts`.

## Characters

Each AI keeps its own way of fighting:

| AI | Character | How you recognise it |
|---|---|---|
| **balanced** | All-rounder | Fights at about 70 % of weapon range, broadside or nose-on as the guns suit, withdraws below 25 % hull. |
| **aggressive** | Charger | Closes at 160 m/s, fights close, retreats only below 10 %. **Rams its target when out of ammunition** (15–20 % of the time for destroyers and cruisers late in a fight). |
| **brawler** | Close-in slugger | Wants about 30 % of range, nose-on with fixed guns, hardly evades. |
| **kiter** | Hit and run | Fast (180 m/s) and orbits fast. **Backs off at full speed, guns on the target, when an enemy comes inside 80 % of its range.** |
| **sniper** | Marksman | Slow (80 m/s), holds still at full range and waits for its shots. |
| **cautious** | Survivor | Stands furthest off, evades most, leaves at 40 % hull, and **gets away at full speed when locally outgunned 1.5 : 1**, seen from 4 km, before it is in gun range. |
| **retreating** | Fighting withdrawal | Always falls back at 20 m/s with its guns on the threat, and fights once out of reach. |
| **defensive** | Escort | Stays with its charge and engages only what comes within 2.5 km of it. |
| **carrier** | Drone mother | Launches drones at 4 km, stands off at about 2.9 km, and gets away when outgunned 2 : 1. |
| **fleet-pass** | Cavalry | Formation passes through the enemy at 300 m/s, then comes about. |
| **missile-wall** | Line of battle | Stands off at 85 % of missile range in a wall and fires synchronised salvos. |

**Disarmed ships escape.** A ship of any type with nothing left to fire, except the aggressive one, escapes at
1.6 × its top speed, sliding along the arena edge rather than stopping against it. A campaign gets the ship
back instead of a wreck. In a closed arena a determined pursuer with more fuel still corners it.

## Results (score: win 1, draw ½, out of 3; average hull kept)

| AI | Wasp (small) | Rapier (medium) | Anvil (large) | Viper (missile) | Ark (carrier) |
|---|---|---|---|---|---|
| balanced | 1.5 · 61 % | 1.0 · 44 % | 1.5 · 55 % | 1.5 · 77 % | 1.5 · 77 % |
| aggressive | **2.0** · 66 % | **2.0** · 56 % | 1.0 · 58 % | 1.5 · 75 % | 1.5 · 80 % |
| brawler | 1.0 · 47 % | **2.0** · 59 % | **2.0** · 61 % | 1.5 · 75 % | 1.5 · 73 % |
| kiter | 1.5 · 59 % | 1.0 · 50 % | 1.0 · 55 % | 1.0 · 68 % | 1.0 · 80 % |
| sniper | **2.0** · 63 % | **2.0** · 61 % | 1.5 · 63 % | 1.5 · 68 % | 1.5 · 71 % |
| cautious | **2.0** · 69 % | **2.0** · 55 % | 1.5 · **71 %** | 1.0 · 62 % | 1.5 · **84 %** |
| retreating | 1.5 · 57 % | 1.0 · 49 % | 1.5 · 69 % | 1.5 · 75 % | 1.5 · **84 %** |
| defensive | **3.0** · 64 % | 1.5 · 51 % | 1.5 · 66 % | 1.5 · 76 % | **2.0** · 80 % |
| carrier | **2.0** · 58 % | (Ark) 1.5 · 80 % | 1.5 · 70 % | 1.0 · 66 % | 1.5 · 80 % |
| fleet-pass | **2.0** · 66 % | **2.0** · 62 % | 1.5 · 59 % | 1.5 · **87 %** | 0.5 · 71 % |
| missile-wall | (Maul) 1.0 · 36 % | (Viper) 1.0 · 58 % | (Squall) **2.5 · 99 %** | 1.0 · 58 % | 1.5 · 89 % |

**Against the stronger enemy, hull kept at the end:**

| AI | Hull kept |
|---|---|
| cautious | **54–65 %** |
| retreating | 30–47 % |
| kiter | 27–44 % |
| everyone else | 13–36 % |

Every profile still lost these battles: twice the force wins in a closed arena.

## Recommendations

**By ship:**

| Ship | Best AI | Also good | Avoid |
|---|---|---|---|
| Fighters (Wasp) | **defensive** as an escort (3 of 3) | aggressive or fleet-pass to intercept; cautious to come home | brawler: it never gets close enough and takes the hits |
| Destroyers with guns (Rapier) | **aggressive** or **brawler** | sniper (keeps 61 % hull), fleet-pass | balanced, kiter and retreating are a step behind |
| Cruisers and heavier gun ships (Anvil) | **brawler** | cautious (keeps the most hull), retreating | aggressive: it closes too fast and soaks up fire |
| Missile ships alone (Viper) | **fleet-pass** (in and out, 87 % hull) | balanced, defensive | missile-wall alone: a wall needs several ships |
| Heavy missile ships (Squall) | **missile-wall** (2.5 of 3, 99 % hull) | | |
| Carriers (Ark) | **defensive** (keep it with the fleet) or **carrier** | cautious, retreating (they survive) | fleet-pass: a carrier flown into the enemy loses its drones' advantage |

**By situation:**

| Situation | Use |
|---|---|
| Must win against an equal enemy | aggressive or brawler (medium), sniper (medium and small) |
| Must keep the ship (campaign, valuable ship, outnumbered) | **cautious**, then retreating |
| Protect a ship | defensive on fighters and destroyers |
| A group of missile ships | missile-wall (synchronised salvos beat point defense better than single launches) |
| Fast ships against slower, heavier enemies | kiter or fleet-pass |
| Delaying action | retreating |
| Out of ammunition and expendable | aggressive (it rams) |

## Officers

An officer can have a **default AI** (`ai` in the roster file, the "AI:" choice on the officer card). When the
officer commands a ship flown by the AI, that profile is used:

- **Who commands:** the captain, or the pilot of a fighter.
- **Which ships:** your other ships in flight mode, and ships you command in strategy mode.

It is optional: without it the ship gets the usual default. The card marks the profile that suits the officer's
traits (`suggestedAi()`):

| Traits | Suggested AI |
|---|---|
| steady hand, eagle eye | sniper |
| smooth helm | kiter |
| daredevil, hot-rodder, reckless | aggressive |
| gunnery expert, quick loader, heavy-handed | brawler |
| missile savant | missile-wall |
| point-defense ace, slow reflexes | defensive |
| nervous, timid throttle, gun-shy | cautious |
| none of these standing out | balanced |
