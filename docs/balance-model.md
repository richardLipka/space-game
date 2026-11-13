# Balance model (catalogue v0-8)

Every component's numbers come from one table of parameters and a set of formulas in
[`src/data/balance/model.ts`](../src/data/balance/model.ts). The core catalogue is generated from it, the
simulation reads the same table at run time, and a test fails when the two drift apart.

To tune the game: change a parameter (or a part's outline or its `balance` factors), then run

```bash
npm run balance:derive
```

```bash
npm run golden:update
```

## Volume

A part's volume is its outline area times the deck height (`depth`, 1 m), so a 1 × 1 m part is 1 m³.
Mass and hit points are a density per component class times the volume:

| Class | kg/m³ | HP/m³ | | Class | kg/m³ | HP/m³ |
|---|---|---|---|---|---|---|
| structure | 60 | 324 | | battery | 90 | 324 |
| armor | 160 | 1081 | | radiator | 60 | 216 |
| command | 135 | 1920 | | heat sink | 200 | 649 |
| engine | 200 | 541 | | tank (dry) | 30 | 324 |
| ion engine | 260 | 433 | | magazine (dry) | 40 | 433 |
| thruster | 60 | 540 | | weapon | 170 | 540 |
| gyro | 120 | 433 | | hangar | 100 | 360 |
| reactor | 270 | 600 | | decoy | 40 | 432 |

A part can scale what the model gives it with `balance: { mass, hp, output, internalShare }` in the
catalogue (for example the heavy cannon turret weighs 2.6 times a weapon of its volume). Cost, ranges,
turn rates and gun damage are still set by hand per part.

## Relations

| Relation | Formula | Parameters (default) |
|---|---|---|
| Magazine | rounds = `fireTime` ÷ interval × V ÷ `volumePerGame` | `game.fireTime` 120 s. A 1 m³ magazine feeds one gun for one game: 60 heavy shells, 1000 autocannon rounds, 4000 PD rounds, 480 flak shells |
| Stowed ammunition | round mass = `ammoDensity` × `volumePerGame` ÷ rounds | `ammoDensity` 360 kg/m³: a full gun magazine weighs the same whatever the calibre |
| Rounds in the gun | `fireTime` ÷ own interval × `internalShare` | `weapons.internalShare` 0.1 (12 s of fire) |
| Reactor | output = `power.perVolume` × V | 200 kW/m³: one cubic metre runs one laser turret, as one small magazine feeds one gun |
| Command module | a reactor of its volume × `commandShare` | 0.15 (67.5 kW for the small command module) |
| Energy is heat | reactor heat = output × `heatPerWatt` | 1: every watt generated is a watt of heat. Beam weapons add none of their own (`heat.beamExtra` 0) |
| Radiator | dissipation = `radiatorTurrets` × laser turret draw × V | 2 → 400 kW per m³: one small radiator cools two laser turrets, no more |
| Hull | `hullPerMetre` × exposed outline | 2.5 kW/m, so small ships manage without radiators |
| Battery | `energyPerVolume` × V; full charge in `chargeTime`, discharge in `dischargeTime` | 2 MJ/m³, 10 s, 5 s |
| Heat sink | `sinkPerVolume` × V | 20 MJ/m³ |
| Tank | `fuel.perVolume` × V | 500 kg/m³ |
| Engine | thrust = `thrustBase` × V^`thrustExponent`; Isp = `ispBase` × V^`ispExponent` | 23.6 kN, 1.3, 720 s, 0.05: bigger engines are more efficient |
| Thruster | thrust = `thrustPerVolume` × V | 12 kN/m³, Isp 512 s |
| Engine heat | fuel flow × `heat.perKgFuel` | 12 kJ per kg burned (fuel flow = thrust ÷ (Isp × g₀)) |
| Ion engine | thrust = `ion.thrustShare` × a chemical engine's; power = thrust × `ion.powerPerNewton` | 15 %, Isp 12 000 s, 30 W/N. The power becomes reactor heat |
| Gun heat | ½·m·v² × `heat.muzzleShare` per shot | 1.2 % of the muzzle energy |
| Loading | energy = `ordnance.loadEnergyPerKg` × mass | 2.5 kJ/kg: 22.5 kW while a launcher reloads, 37.5 kW while a hangar readies a drone. Without the power both are slower |
| Warheads | smart missile = `damageFactor` × `kineticDamage`; rocket × `rocketWarheadShare` | 10 × 400 = 4000; rockets 2400 |

## What it gives (v0-8)

| Part | Volume | Result |
|---|---|---|
| Reactor S / M | 2.25 / 9 m³ | 450 kW / 1.8 MW |
| Radiator S | 1 m³ | 400 kW |
| Laser turret | | draws 200 kW, which is 200 kW of heat |
| Engine S / L | 1.5 / 6 m³ | 40 kN, 67 kW heat / 242 kN, 376 kW heat |
| Ion engine S / L | 1.5 / 6 m³ | 6 kN for 180 kW / 36 kN for 1.09 MW |
| Kinetic / autocannon magazine | 1 m³ | 60 / 1000 rounds, 360 kg full |
| Smart missile / rocket magazine | 1.5 m³ | 12 smart missiles / 24 rockets |

## Changes in behaviour that come with it

- **Missiles are the magazine's.** A launcher holds nothing; it loads the selected type from the missile
  magazines on its network (smart missiles first when nothing is selected). Z or the ordnance panel picks
  the type; U picks the drone type H launches.
  - Smart missile: steers while its motor burns (8 s), 4000 damage.
  - Rocket: flies straight where the launcher points, 2400 damage, half the mass, reloads in half the time,
    can be fired without a target. The AI fires rockets only when the launcher points within 6° of the
    intercept.
- **Missiles destroy themselves** 10 s after their motor burns out.
- **Drones** with no working weapon or no ammunition ram the nearest enemy that is still fighting and blow
  up at its hull (damage 6 × their mass). With no fuel either, they destroy themselves.
- **Drive mode** (I, ships with ion engines): all engines, ion only or chemical only.

## Known consequences to tune next

- **Cooling is cheap for gun ships.** Radiators went from 150 to 400 kW while engines and guns heat about
  as before, so the fleet's ships now carry two to three times the cooling they need. Either the fleet
  drops radiators or `heat.perKgFuel` and `heat.muzzleShare` go up.
- **Ammunition is tighter.** Magazines hold about a third of what they did (120 s of continuous fire per
  gun). Ships with several guns on one magazine run dry in long fights.
- **Missiles are decisive.** At 4000 damage one hit destroys most parts within 5 m. Point defense and
  decoys matter far more; the automated AI games should set `damageFactor`.
- **Costs are not derived.** A part's cost is still hand-set; the model should price volume and output.
