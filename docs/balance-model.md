# Balance model (catalogue v0-8)

Every component's numbers come from one table of exchange rates and a set of formulas in
[`src/data/balance/model.ts`](../src/data/balance/model.ts). The core catalogue is generated from it, and a
test fails when the two drift apart. The game reads the same formulas at run time: the editor, the
simulation, the AI and the part info panel all call them rather than writing their own.

To tune the game, change a rate (or a part's outline or its `balance` factors), then run:

```bash
npm run balance:derive
```

```bash
npm run golden:update
```

`npm run tuning` searches the rates automatically ([docs/tuning.md](tuning.md)).

## Anchors and units

- **Volume:** a part's outline area times the deck height (`depth`, 1 m), so a 1 × 1 m part is 1 m³.
- **Hit points:** structure has `hp.structure` = 324 HP per m³. This is the one fixed anchor; every other
  HP and every damage number is measured against it.
- **Energy:** counted in reference energy turrets (`energyTurret`, the small laser turret: 200 kW for
  1.59 m³). Reactors, radiators and hull cooling are given in turrets.
- **Mass:** a density per component class (kg/m³), unchanged from before.

## Relations

| Relation | Formula | Rates (current) |
|---|---|---|
| Hit points | `hp.structure` × class ratio × V; systems also × `hp.systems` | armor 3.34, command 5.93, weapon 1.67; systems 0.67 (radiator) to 2.0 (heat sink) |
| Magazine | rounds = `fireTime` ÷ interval × V ÷ `volumePerGame` | 120 s: a 1 m³ magazine feeds one gun for one game |
| Stowed ammunition | round mass = `ammoDensity` × `volumePerGame` ÷ rounds | 360 kg/m³ |
| Rounds in the gun | `fireTime` ÷ own interval × `internalShare` | 0.1 |
| Reactor | `turretsPerVolume` × turret draw × V | 1 turret per m³ (200 kW/m³); command modules × 0.15 |
| Energy is heat | reactor heat = output × `heatPerWatt` | 1 |
| Radiator | `radiatorTurrets` × turret draw × V | 2 turrets per m³ |
| Hull | `hullTurretsPerMetre` × turret draw per metre of exposed outline | 0.0125 (2.5 kW/m) |
| Beam power | turret draw × V ÷ turret volume × output factor | lance × 2.39 |
| Engine | thrust = `thrustBase` × V^1.3; Isp = `ispBase` × V^0.05 | 23.6 kN, 720 s |
| Engine heat | fuel flow × `perKgFuel` | 12 kJ/kg |
| Ion engine | `thrustShare` of a chemical engine; power = thrust × `powerPerNewton` | 15 %, 30 W/N |
| Gun heat | ½·m·v² × `muzzleShare` per shot | 1.2 % |
| Loading | `loadEnergyPerKg` × mass | 2.5 kJ/kg |
| **System volume** | weapon V + magazine for a game + power ÷ reactor per m³ + heat ÷ radiator per m³ | laser S 3.1 m³, autocannon S 2.7 m³ |
| **Damage rate** | `hp.structure` ÷ `killTime` × family × (range ÷ 1500)^−`range.exponent` × (interval ÷ 0.12)^`calibre.exponent` × system volume × part factor | `killTime` 4.66 s; family kinetic 1, beam 0.41, missile 1.85, pd 1.52; exponents 0 |
| Damage per round | damage rate × fire interval; a burst is × the part's `burst` factor | |
| **Armor rating** | `armor.stop` × `hp.structure` ÷ `killTime` × plate factor | 0.288 s → 20 per hit |
| **Warhead** | missile system (launcher 1.5 m³ + magazine + loading reactor) × missile rate × reload interval × type factor | smart 4000, rocket 2400 |
| Missile HP | `hp.structure` × `missilePerKg` × mass × type factor | smart 30, rocket 20 |

"Damage rate" means every round on target and no armor. **Kill time** sets the pace: the seconds one m³ of
kinetic weapon system takes to destroy one m³ of structure. Armor ratings and warheads scale with it, so
armor keeps the same meaning when fights get faster or slower.

## Per-part factors

A part's `balance` factors give it character within its class; they are not a way around a missing rule.
They were set so that the formulas reproduce v0-8 exactly:

| Part | Factor | Why |
|---|---|---|
| autocannon S, laser S, PD gatling | damage 1 | the references of their families |
| medium cannon turret | damage 1.01 | |
| light autocannon | damage 1.06 | fast and light |
| fixed cannon M | damage 0.67 | weaker than the turret version (a v0-8 inconsistency worth revisiting) |
| lance | damage 1.33, output 2.39 | long-range beam that earns more than its system volume |
| flak | damage 0.18, burst 1.8 | does its work with bursts |
| drone gun | damage 2.79 | carries its whole game's ammunition, so its system is small |
| armor M plates, wedge | armor 1.5, 1.25 | thicker plates |

Each part's mass, HP and output factors are unchanged from before.

## Shared formulas the app uses

| Function | Used by |
|---|---|
| `weaponPowerDemand`, `weaponHeatRate` | ship power and heat simulation, editor stats, part info |
| `weaponDps` | AI capability profile, threat ranking, part info |
| `fuelFlow`, `effectiveIsp`, `deltaV`, `G0` | flight model (propulsion), editor stats, AI capabilities |
| `hullPerMetre` | heat system (hull radiation) |

## Behaviour that comes with it

- **Missiles belong to the magazine.** A launcher holds nothing itself; it loads the selected type from the
  missile magazines on its network (smart missiles first when nothing is selected). Z or the ordnance panel
  picks the type; U picks which drone type H launches.
  - Smart missile: steers while its motor burns (8 s).
  - Rocket: flies straight where the launcher points, half the mass, reloads in half the time, and can be
    fired without a target. The AI fires rockets only when the launcher points within 6° of the intercept.
- **Missiles destroy themselves** 10 s after their motor burns out.
- **Drones** with no working weapon or no ammunition ram the nearest enemy that is still fighting and blow
  up at its hull (damage 6 × their mass). With no fuel either, they destroy themselves.
- **Drive mode** (I, ships with ion engines): all engines, ion only or chemical only.

## Not yet derived

- **Costs** are still set by hand per part.
- **Some performance numbers** are still set by hand per part: gyro torque, missile thrust, fuel and turn
  rate, weapon ranges, fire intervals, turret traverse and spread.
- **Fixed-value constants:** the minimum damage per hit (2), ramming damage per kg and collision damage are
  fixed values, not tied to `killTime`.

## Known consequences to tune next

- **Cooling is cheap for gun ships:** fleet ships carry two to three times the cooling they need.
- **Ammunition is tight** for ships with several guns on one magazine.
- **Missiles are decisive:** two smart missiles strip a medium ship of its weapons.
- **Beams are weak:** they deal 0.41 of a kinetic weapon's damage per m³ of system and have shorter range
  (1200 m against 1500 m for the autocannon).
