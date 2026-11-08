import profilesJson from "./profiles.json";
import { AiProfileSet, type AiProfile } from "../schemas/ai";
import { validate } from "../validate";

/** Built-in AI profiles (spec §11.2), validated at load. Scenarios reference them by id. */
function load(): ReadonlyMap<string, AiProfile> {
  const r = validate(AiProfileSet, profilesJson);
  if (!r.ok) throw new Error(`Invalid AI profiles:\n${r.errors.join("\n")}`);
  return new Map(r.value.profiles.map((p) => [p.id, p]));
}

export const AI_PROFILES = load();

export function aiProfile(id: string): AiProfile {
  const p = AI_PROFILES.get(id);
  if (!p) throw new Error(`Unknown AI profile "${id}"`);
  return p;
}
