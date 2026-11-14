/** Browser entry: app shell with the ship editor (default) and the flight screen (test flight / sandbox). */
import { preferredFlightModel } from "./ui/flight-model";
import { Application } from "pixi.js";
import catalogueJson from "./data/core/catalogue.json";
import fighterJson from "./data/designs/demo-fighter.json";
import haulerJson from "./data/designs/demo-hauler.json";
import gunboatJson from "./data/designs/demo-gunboat.json";
import frigateJson from "./data/designs/demo-frigate.json";
import picketJson from "./data/designs/demo-picket.json";
import droneAttackJson from "./data/designs/drone-attack.json";
import dronePdJson from "./data/designs/drone-pd.json";
import droneDecoyJson from "./data/designs/drone-decoy.json";
import sandboxJson from "./data/scenarios/m1-sandbox.json";
import { makeCruiserDesign } from "./data/designs/generate";
import { validateCatalogue, validateDesign, validateScenario, type ValidationResult } from "./data/validate";
import type { ShipDesign } from "./data/schemas/design";
import type { PartDef } from "./data/schemas/part";
import { IdbLibrary } from "./data/share/idb-library";
import { MemoryLibrary, type Library } from "./data/share/library";
import { degToRad, vec2 } from "./sim/core/vec2";
import { aiProfile, AI_PROFILES } from "./data/ai/index";
import { BUNDLED_DESIGNS, FLEET, PLATFORMS } from "./data/designs/index";
import { safeStorage } from "./ui/storage";
import {
  applySkirmishOrders,
  DEFAULT_SKIRMISH,
  skirmishBattle,
  type SkirmishSetup,
} from "./sim/scenario/skirmish";
import { startBattle } from "./sim/scenario/battle";
import type { Scenario } from "./data/schemas/scenario";
import { ResultStore } from "./ui/results";
import { createWorldFromScenario } from "./sim/scenario/setup";
import { PartCatalogue } from "./sim/ship/catalogue";
import { applyTheme, domStyleSource, ThemeResolver, THEMES, type ThemeName } from "./render/theme";
import { FlightScreen } from "./ui/flight-screen";
import { InputController } from "./ui/input";
import { EditorScreen, type EditorServices } from "./ui/editor/editor-screen";
import { el } from "./ui/editor/dom";
import { ScenarioEditor } from "./ui/scenario-editor";

function must<T>(r: ValidationResult<T>, what: string): T {
  if (!r.ok) throw new Error(`Invalid ${what}:\n${r.errors.join("\n")}`);
  return r.value;
}

const LAST_DESIGN_KEY = "space-game.lastDesignId";
const SEEDED_KEY = "space-game.seeded.v6";

function randomId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function main(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const hudEl = document.getElementById("hud")!;
  const app = new Application();
  await app.init({ canvas, resizeTo: window, antialias: true, backgroundAlpha: 0, preference: "webgl" });

  const core = PartCatalogue.fromJson(must(validateCatalogue(catalogueJson), "catalogue"));
  const sandbox = must(validateScenario(sandboxJson), "scenario");
  const fighter = must(validateDesign(fighterJson), "fighter");
  const hauler = must(validateDesign(haulerJson), "hauler");
  const gunboat = must(validateDesign(gunboatJson), "gunboat");
  const frigate = must(validateDesign(frigateJson), "frigate");
  /** Larger classes: gun cruiser (broadside) and missile frigate. */
  const newClasses = ["demo-cruiser-guns", "demo-frigate-missile"].map((id) => BUNDLED_DESIGNS.get(id)!);
  const picket = must(validateDesign(picketJson), "picket");
  /** Drone types the core hangars launch (spec §9.7); library copies with the same id override them. */
  const coreDrones = [droneAttackJson, dronePdJson, droneDecoyJson].map((j) =>
    must(validateDesign(j), "drone"),
  );
  const droneDesigns = new Map(coreDrones.map((d) => [d.id, d]));

  let library: Library;
  try {
    library = await IdbLibrary.open();
  } catch {
    library = new MemoryLibrary();
  }
  // Seeding only adds designs that are missing, so a new key brings new ships without touching edits.
  if (!safeStorage.get(SEEDED_KEY)) {
    for (const d of [
      fighter,
      hauler,
      gunboat,
      frigate,
      picket,
      ...coreDrones,
      ...newClasses,
      ...FLEET,
      ...PLATFORMS,
    ])
      if (!(await library.getDesign(d.id))) await library.putDesign(d);
    safeStorage.set(SEEDED_KEY, "1");
  }

  let userParts: PartDef[] = [];
  let catalogue = core;
  const refreshCatalogue = async () => {
    userParts = (await library.listParts()).map((p) => p.def);
    for (const d of await library.listDesigns()) if (d.drone) droneDesigns.set(d.id, d);
    catalogue = new PartCatalogue(core.version, [...core.all().map((p) => p.def), ...userParts]);
  };
  await refreshCatalogue();

  const theme = new ThemeResolver(domStyleSource(document));
  let themeIndex = 0;
  await applyTheme(document, THEMES[themeIndex]!, theme); // before the first frame is drawn
  const cycleTheme = () => {
    themeIndex = (themeIndex + 1) % THEMES.length;
    void applyTheme(document, THEMES[themeIndex]!, theme);
  };

  const toastBox = el("div", { class: "toasts", "data-testid": "toasts" });
  document.body.append(toastBox);
  const toast = (message: string, kind: "info" | "error" = "info") => {
    const t = el("div", { class: `toast ${kind}` }, message);
    toastBox.append(t);
    setTimeout(() => t.remove(), kind === "error" ? 6000 : 3000);
  };

  const input = new InputController();
  input.attach(window, canvas);
  const flight = new FlightScreen(app, theme, hudEl, input);
  flight.themeName = () => THEMES[themeIndex]!;

  let mode: "editor" | "flight" | "scenario" = "editor";
  /** Where Exit from a flight returns to: the scenario editor when the battle was started there. */
  let returnTo: "editor" | "scenario" = "editor";
  const toEditor = () => {
    flight.stop();
    if (returnTo === "scenario") {
      mode = "scenario";
      void scenarioEditor.show();
      return;
    }
    mode = "editor";
    editor.show();
  };
  flight.onCommand = (cmd) => {
    if (cmd === "exit") toEditor();
    else if (cmd === "theme") cycleTheme();
  };

  /** Enemy ships flown by the AI (spec §11): design, profile and spawn point. */
  type EnemyAi = { design: ShipDesign; profile: string; x: number; y: number };
  const startFlight = (
    designs: ShipDesign[],
    title: string,
    dummies: ShipDesign[],
    enemies: EnemyAi[] = [],
  ) => {
    const world = createWorldFromScenario(sandbox);
    for (const d of droneDesigns.values()) world.registerDesign(d);
    const ships = designs.map((d, i) => {
      const sp = sandbox.playerSpawns[i] ?? { position: [0, i * 50], angle: 0 };
      return world.addShip(d, catalogue, {
        position: vec2(sp.position[0], sp.position[1]),
        angle: degToRad(sp.angle),
      });
    });
    dummies.forEach((d, i) =>
      world.addShip(d, catalogue, { position: vec2(250 + i * 60, 80 - i * 160), angle: Math.PI, team: 1 }),
    );
    for (const e of enemies) {
      const s = world.addShip(e.design, catalogue, { position: vec2(e.x, e.y), angle: Math.PI, team: 1 });
      world.setAi(s.id, aiProfile(e.profile));
    }
    // Test flights and the sandbox use the model picked in the toolbar.
    world.flightModel = preferredFlightModel();
    editor.hide();
    mode = "flight";
    flight.start({ world, playerShips: ships, title });
  };

  const results = new ResultStore();
  /** Scenario battle (spec §12): enemies from bundled and library designs, results saved locally. */
  const startScenario = (scenario: Scenario, fleet: ShipDesign[], spectate = false) => {
    void library.listDesigns().then((saved) => {
      scenarioEditor.hide();
      const designs = new Map(BUNDLED_DESIGNS);
      for (const d of saved) if (!designs.has(d.id)) designs.set(d.id, d);
      const battle = startBattle(scenario, fleet, catalogue, {
        designs,
        profiles: AI_PROFILES,
        droneDesigns: [...droneDesigns.values()],
      });
      editor.hide();
      mode = "flight";
      flight.start({
        world: battle.world,
        // Watching without a fleet (scenario editor): follow the AI ships instead.
        playerShips:
          battle.playerShips.length > 0 ? battle.playerShips : [...battle.allyShips, ...battle.enemyShips],
        title: `${spectate ? "Watching" : "Scenario"} ${scenario.order ?? ""}: ${scenario.name}`,
        battle,
        spectate,
        onBattleEnd: (b) => {
          if (spectate) return;
          results.add({
            scenarioId: scenario.id,
            won: b.status === "won",
            time: b.endTime ?? b.world.time,
            dealt: Math.round(b.tally.dealt),
            taken: Math.round(b.tally.taken),
            partsLost: b.tally.partsLost,
            cost: fleet.reduce(
              (t, d) => t + d.parts.reduce((u, p) => u + catalogue.get(p.partId).def.cost, 0),
              0,
            ),
            fleet: fleet.map((d) => d.name),
            at: new Date().toISOString(),
          });
        },
        retry: () => startScenario(scenario, fleet, spectate),
      });
    });
  };

  /** Skirmish (sides, ships, AI types) as a destroy-all battle; without a player ship it is watched. */
  const startSkirmish = (setup: SkirmishSetup) => {
    void library.listDesigns().then((saved) => {
      const designs = new Map(BUNDLED_DESIGNS);
      for (const d of saved) designs.set(d.id, d);
      const span = Math.max(12000, setup.distance + 6000);
      const sk = skirmishBattle(setup, designs, {
        width: span,
        height: span * 0.75,
        asteroids: [],
        gravityWells: [],
      });
      const battle = startBattle(sk.scenario, sk.fleet, catalogue, {
        designs,
        profiles: sk.profiles,
        droneDesigns: [...droneDesigns.values()],
      });
      applySkirmishOrders(battle, sk, setup);
      battle.world.flightModel = setup.flightModel ?? "newtonian";
      const watch = battle.playerShips.length === 0;
      editor.hide();
      mode = "flight";
      flight.start({
        world: battle.world,
        playerShips: watch ? [...battle.allyShips, ...battle.enemyShips] : battle.playerShips,
        title: watch ? "Watching: skirmish" : "Skirmish",
        battle,
        spectate: watch,
        retry: () => startSkirmish(setup),
      });
    });
  };

  const services: EditorServices = {
    library,
    core: () => core,
    catalogue: () => catalogue,
    refreshCatalogue: async () => {
      await refreshCatalogue();
      editor.onCatalogueChanged();
    },
    newId: () => `ship-${randomId()}`,
    now: () => new Date().toISOString(),
    testFlight: (d) => startFlight([d], `Test flight: ${d.name}`, [hauler, hauler, picket]),
    openSandbox: () =>
      startFlight([gunboat, fighter, frigate, makeCruiserDesign()], "Flight sandbox", [
        hauler,
        hauler,
        picket,
      ]),
    skirmishDesigns: async () => {
      const designs = new Map(BUNDLED_DESIGNS);
      for (const d of await library.listDesigns()) designs.set(d.id, d);
      return [...designs.values()];
    },
    startSkirmish: (setup) => startSkirmish(setup),
    startScenario: (s, f) => {
      returnTo = "editor";
      startScenario(s, f);
    },
    watchScenario: (s, f) => {
      returnTo = "editor";
      startScenario(s, f, true);
    },
    results,
    bundledDesign: (id) => BUNDLED_DESIGNS.get(id),
    cycleTheme,
    toast,
    openScenarioEditor: () => {
      editor.hide();
      mode = "scenario";
      void scenarioEditor.show();
    },
  };

  const allDesigns = async () => {
    const designs = new Map(BUNDLED_DESIGNS);
    for (const d of await library.listDesigns()) designs.set(d.id, d);
    return designs;
  };
  const scenarioEditor = new ScenarioEditor({
    designs: allDesigns,
    importDesigns: async (ds) => {
      for (const d of ds) await library.putDesign({ ...d, section: d.section ?? "Imported" });
    },
    profiles: [...AI_PROFILES.keys()],
    catalogue: () => catalogue,
    watch: (s) => {
      returnTo = "scenario";
      startScenario(s, [], true);
    },
    play: (s) => {
      returnTo = "scenario";
      startScenario(s, [structuredClone(editor.model.design)]);
    },
    back: () => {
      scenarioEditor.hide();
      returnTo = "editor";
      mode = "editor";
      editor.show();
    },
    toast,
  });

  const lastId = safeStorage.get(LAST_DESIGN_KEY);
  const initial = (lastId && (await library.getDesign(lastId))) || fighter;
  const editor = new EditorScreen(app, theme, canvas, services, initial);
  editor.show();
  requestAnimationFrame(() => editor.fitView());

  // Debug/test handles (Playwright and manual inspection).
  const debug = {
    get world() {
      return flight.world;
    },
    get controlled() {
      return flight.controlledShip?.id ?? null;
    },
    get mode() {
      return mode;
    },
    hash: () => flight.world?.hash() ?? null,
    pause: (p: boolean) => (flight.paused = p),
    setTheme: async (name: ThemeName) => {
      themeIndex = THEMES.indexOf(name);
      await applyTheme(document, name, theme);
    },
    resolveStyle: (classes: string) => theme.resolve(classes),
    openSandbox: () => services.openSandbox(),
    openSkirmish: (setup?: SkirmishSetup) => startSkirmish(setup ?? DEFAULT_SKIRMISH),
    /** Scenario battle state (tests): status, enemies left, results shown. */
    battle: () => {
      const b = flight.battle;
      return b ? { status: b.status, enemies: b.enemyShips.map((s) => s.id), reason: b.reason } : null;
    },
    /** Destroys every enemy's command module (scripted fight for tests). */
    killEnemies: () =>
      flight.battle?.enemyShips.forEach((s) => s.destroyPart(s.parts.find((p) => p.def.def.command)!.uid)),
    /** AI state of a ship (behaviour, order, target), for tests. */
    ai: (id: string) => {
      const st = flight.world?.ai.get(id);
      return st ? { behaviour: st.behaviour, order: st.order?.kind ?? null, target: st.targetId } : null;
    },
    /** Ids of the player's ships (index 0 starts under control). */
    playerShips: () => (flight.world ? flight.playerIds() : []),
    toEditor,
    /** Controlled ship (flight mode). */
    get ship() {
      return flight.controlledShip;
    },
    /** Starts a test flight with the given design (validated like the editor's button). */
    testFlight: (d: ShipDesign) => services.testFlight(must(validateDesign(d), "design")),
    killPart: (uid: string) => flight.controlledShip?.destroyPart(uid),
    /** Holds the controlled ship's trigger (test hook; aims at the cursor like the mouse would). */
    activateWeapons: (on: boolean) => {
      flight.debugTrigger = on;
    },
    /** Selects a target ship by id (test hook for RMB). */
    setTarget: (id: string | null) => {
      flight.targetId = id;
    },
    get target() {
      return flight.targetId;
    },
    screenOfShip: (id: string) => flight.screenOfShip(id),
    /** Screen position of a part's centre on the controlled ship (test hook for eject clicks). */
    screenOfPart: (uid: string) => flight.screenOfPart(uid),
    /** Uids of the controlled ship's parts. */
    partUids: () => flight.controlledShip?.parts.map((p) => p.uid) ?? [],
    debrisCount: () => flight.world?.debris.length ?? 0,
    /** Ids of ships on other teams (drones excluded). */
    enemies: () =>
      flight.world
        ?.allShips()
        .filter((s) => s.team !== flight.controlledShip?.team && !s.drone)
        .map((s) => s.id) ?? [],
  };
  Object.assign(window, { __game: debug, __editor: editor, __scenarioEditor: scenarioEditor });

  let last = performance.now();
  const frame = (now: number): void => {
    // Schedule first: an exception in one frame must not stop the app.
    requestAnimationFrame(frame);
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (mode === "editor") editor.frame(dt, app.screen.width, app.screen.height);
    else if (mode === "flight") flight.frame(dt);
  };
  requestAnimationFrame(frame);
}

main().catch((e: unknown) => {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<pre style="color:#f55;padding:20px">${String(e instanceof Error ? e.stack : e)}</pre>`,
  );
  throw e;
});
