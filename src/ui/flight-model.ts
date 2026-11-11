import { FLIGHT_MODELS, type FlightModel } from "../sim/flight/arcade";
import { el } from "./editor/dom";
import { safeStorage } from "./storage";

const STORE_KEY = "space-game.flight-model.v1";

export const FLIGHT_MODEL_INFO: Record<FlightModel, { name: string; help: string }> = {
  newtonian: {
    name: "Newtonian",
    help: "Realistic: thrust adds speed and nothing takes it away. You brake by burning the other way (X).",
  },
  arcade: {
    name: "Arcade",
    help: "Easy: the ship flies while you hold forward, up to its top speed, and stops when you let go. Turning turns where it flies. Heavier ships are slower and take longer to get going.",
  },
};

const isModel = (v: unknown): v is FlightModel => FLIGHT_MODELS.includes(v as FlightModel);

/** Flight model picked last (test flights, the sandbox and new skirmishes start with it). */
export function preferredFlightModel(): FlightModel {
  const v = safeStorage.get(STORE_KEY);
  return isModel(v) ? v : "newtonian";
}

export function rememberFlightModel(model: FlightModel): void {
  safeStorage.set(STORE_KEY, model);
}

/** A labelled <select> of the flight models. */
export function flightModelSelect(
  testid: string,
  value: FlightModel,
  onChange: (m: FlightModel) => void,
): HTMLLabelElement {
  const select = el("select", { "data-testid": testid }) as HTMLSelectElement;
  for (const m of FLIGHT_MODELS) {
    const o = el("option", { value: m }, FLIGHT_MODEL_INFO[m].name) as HTMLOptionElement;
    o.selected = m === value;
    select.append(o);
  }
  const label = el(
    "label",
    { class: "flight-model", title: FLIGHT_MODEL_INFO[value].help },
    "Flight model ",
    select,
  ) as HTMLLabelElement;
  select.addEventListener("change", () => {
    const m = isModel(select.value) ? select.value : "newtonian";
    label.title = FLIGHT_MODEL_INFO[m].help;
    onChange(m);
    select.blur();
  });
  return label;
}
