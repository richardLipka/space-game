import type { PowerGroup } from "../../data/schemas/design";

export const POWER_GROUPS: readonly PowerGroup[] = [
  "propulsion",
  "gyro",
  "weapons",
  "pointDefense",
  "hangar",
];

export interface PowerConsumer {
  readonly uid: string;
  readonly group: PowerGroup;
  /** Watts wanted this tick (may be 0 for an idle consumer that still needs a powered/unpowered answer). */
  readonly demand: number;
}

export interface PowerSource {
  readonly uid: string;
  /** Watts available this tick (already scaled by HP and heat throttling). */
  readonly maxOutput: number;
}

export interface BatteryState {
  readonly uid: string;
  /** Stored energy (J). */
  readonly charge: number;
  readonly capacity: number;
  readonly maxCharge: number;
  readonly maxDischarge: number;
}

export interface PowerResult {
  /** Served fraction per consumer uid, in [0, 1]. */
  readonly factors: ReadonlyMap<string, number>;
  /** Served fraction per group (1 for a fully served or idle group with power left, 0 when browned out). */
  readonly groupFactor: Readonly<Record<PowerGroup, number>>;
  readonly groupDemand: Readonly<Record<PowerGroup, number>>;
  /** Actual reactor output per uid (W) — reactors follow demand, including battery charging. */
  readonly reactorOutput: ReadonlyMap<string, number>;
  /** New battery charge per uid (J). */
  readonly batteryCharge: ReadonlyMap<string, number>;
  /** Total supply capacity this tick (W). */
  readonly supply: number;
  /** Total consumption served (W). */
  readonly used: number;
}

const zeroGroups = (): Record<PowerGroup, number> => ({
  propulsion: 0,
  gyro: 0,
  weapons: 0,
  pointDefense: 0,
  hangar: 0,
});

/**
 * Power allocation for one network (spec §7.2): supply = reactors (up to max) + battery discharge;
 * groups are served fully in priority order; the first group that cannot be fully served shares the
 * remainder proportionally; lower groups get nothing. Surplus reactor capacity charges batteries.
 */
export function allocatePower(
  sources: readonly PowerSource[],
  batteries: readonly BatteryState[],
  consumers: readonly PowerConsumer[],
  priority: readonly PowerGroup[],
  dt: number,
): PowerResult {
  const reactorCap = sources.reduce((s, r) => s + Math.max(0, r.maxOutput), 0);
  const dischargeCaps = batteries.map((b) => Math.max(0, Math.min(b.maxDischarge, b.charge / dt)));
  const batteryCap = dischargeCaps.reduce((s, x) => s + x, 0);
  const supply = reactorCap + batteryCap;

  const order = [...priority, ...POWER_GROUPS.filter((g) => !priority.includes(g))];
  const groupDemand = zeroGroups();
  for (const c of consumers) groupDemand[c.group] += Math.max(0, c.demand);
  const groupFactor = zeroGroups();
  let remaining = supply;
  for (const g of order) {
    const d = groupDemand[g];
    if (d <= 0) {
      groupFactor[g] = remaining > 0 ? 1 : 0;
      continue;
    }
    const alloc = Math.min(d, remaining);
    groupFactor[g] = alloc / d;
    remaining -= alloc;
  }
  const factors = new Map<string, number>();
  for (const c of consumers) factors.set(c.uid, groupFactor[c.group]);

  const used = supply - remaining;
  // Reactors cover consumption first, batteries the rest.
  const fromReactors = Math.min(used, reactorCap);
  const fromBatteries = used - fromReactors;
  // Spare reactor capacity charges batteries.
  const chargeCaps = batteries.map((b) => Math.max(0, Math.min(b.maxCharge, (b.capacity - b.charge) / dt)));
  const chargeWanted = chargeCaps.reduce((s, x) => s + x, 0);
  const charging = Math.min(reactorCap - fromReactors, chargeWanted);

  const reactorOutput = new Map<string, number>();
  const totalReactor = fromReactors + charging;
  for (const r of sources)
    reactorOutput.set(r.uid, reactorCap > 0 ? (totalReactor * Math.max(0, r.maxOutput)) / reactorCap : 0);

  const batteryCharge = new Map<string, number>();
  batteries.forEach((b, i) => {
    const out = batteryCap > 0 ? (fromBatteries * dischargeCaps[i]!) / batteryCap : 0;
    const inn = chargeWanted > 0 ? (charging * chargeCaps[i]!) / chargeWanted : 0;
    batteryCharge.set(b.uid, Math.min(b.capacity, Math.max(0, b.charge + (inn - out) * dt)));
  });

  return { factors, groupFactor, groupDemand, reactorOutput, batteryCharge, supply, used };
}
