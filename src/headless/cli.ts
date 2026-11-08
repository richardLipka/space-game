/**
 * Headless simulation runner (implementation plan M0 task 6).
 *
 *   npm run sim -- --scenario test/fixtures/scenarios/asteroid-field.json --seed 1 --ticks 6000 [--inputs f] [--json]
 *
 * Prints the final tick, state hash and timing. Exit code 1 on invalid input.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { validateInputs, validateScenario } from "../data/validate";
import { createWorldFromScenario } from "../sim/scenario/setup";
import { World } from "../sim/world";

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`cannot read ${path}: ${(e as Error).message}`);
  }
}

const { values } = parseArgs({
  options: {
    scenario: { type: "string" },
    seed: { type: "string" },
    ticks: { type: "string", default: "600" },
    inputs: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log("usage: npm run sim -- [--scenario file] [--seed n] [--ticks n] [--inputs file] [--json]");
  process.exit(0);
}

const ticks = Number(values.ticks);
if (!Number.isInteger(ticks) || ticks < 0) fail("--ticks must be a non-negative integer");
const seed = values.seed !== undefined ? Number(values.seed) : undefined;
if (seed !== undefined && !Number.isInteger(seed)) fail("--seed must be an integer");

let world: World;
if (values.scenario) {
  const r = validateScenario(readJson(values.scenario));
  if (!r.ok) fail(`invalid scenario ${values.scenario}:\n  ${r.errors.join("\n  ")}`);
  world = createWorldFromScenario(r.value, seed !== undefined ? { seed } : {});
} else {
  world = new World({ seed: seed ?? 1 });
}

let frameCount = 0;
if (values.inputs) {
  const r = validateInputs(readJson(values.inputs));
  if (!r.ok) fail(`invalid inputs ${values.inputs}:\n  ${r.errors.join("\n  ")}`);
  frameCount = r.value.frames.length; // applied to ships from M1 onward
}

const start = process.hrtime.bigint();
world.run(ticks);
const ms = Number(process.hrtime.bigint() - start) / 1e6;
const simSeconds = world.time;
const result = {
  tick: world.tick,
  seed: world.seed,
  bodies: world.physics.getState().length,
  inputFrames: frameCount,
  hash: world.hash(),
  wallMs: Math.round(ms * 10) / 10,
  speed: ms > 0 ? Math.round((simSeconds * 1000) / ms) : null,
};

if (values.json) console.log(JSON.stringify(result));
else {
  console.log(`tick ${result.tick}  seed ${result.seed}  bodies ${result.bodies}`);
  console.log(`hash ${result.hash}`);
  console.log(`${result.wallMs} ms wall, ${result.speed ?? "∞"}× real time`);
}
