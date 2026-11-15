import { COPYRIGHT, creditLink, HOMEPAGE } from "./credit";
import { el } from "./editor/dom";

/**
 * Help for every screen (ship editor, scenario editor, flight, strategy): the complete controls, opened with
 * F1 or ? on the keyboard or the Help button with the mouse. One dialog with a tab per screen; it opens on
 * the screen in use.
 */
export type HelpTopic = "ship-editor" | "scenario-editor" | "flight" | "strategy";

type Section = readonly [title: string, rows: readonly (readonly [keys: string, what: string])[]];

export const HELP: Record<
  HelpTopic,
  { readonly title: string; readonly intro: string; readonly sections: readonly Section[] }
> = {
  "ship-editor": {
    title: "Ship editor",
    intro: "Build a ship from parts that snap together edge to edge, check its stats, save it and fly it.",
    sections: [
      [
        "Parts",
        [
          ["Click a part in the palette", "pick it; then click on the map to place copies"],
          ["Esc or right click", "stop placing"],
          ["Q / E (hold)", "rotate the part being placed or the selected part"],
          ["Shift+Q / Shift+E", "rotate in 15° steps"],
          ["Alt (hold)", "place without snapping"],
          ["Click a part", "select it; drag to move it (what hangs on it moves along)"],
          ["Ctrl+drag", "move a part alone"],
          ["Delete / Backspace", "remove the selected parts"],
          ["1–9 / 0", "put the selected weapons in weapon group 1–9 / take them out"],
          ["Search box", "find parts by name; categories fold open and shut"],
        ],
      ],
      [
        "View",
        [
          ["Mouse wheel", "zoom"],
          ["Middle drag", "pan"],
          ["F", "fit the ship in view"],
          ["M", "mirror mode: every placement gets its mirror twin"],
          ["G", "connection graph"],
          [
            "Overlays menu",
            "centre of mass, thrust, turret arcs, networks, exposed edges, connections, firepower",
          ],
          [
            "Firepower & attack front overlay",
            "damage per second the weapons can put out in each direction (from their arcs), and an arrow on the strongest side: the attack front, saved with the design and shown in the stats",
          ],
          ["T", "next colour theme"],
        ],
      ],
      [
        "Design",
        [
          ["Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z)", "undo / redo"],
          ["Ctrl+S or Save", "save to the library"],
          ["Library", "load, delete or move designs between sections (Playable, Experimental, …)"],
          ["Export / Import", "files, JSON and share codes"],
          [
            "Stats, issues, groups, power priority",
            "panels on the right; issues highlight the parts concerned",
          ],
          ["Radiators", "keep 1 m clear in front of their faces; the shaded zone shows where while placing"],
        ],
      ],
      [
        "Go",
        [
          ["Test flight", "fly the ship against dummies"],
          ["Scenarios / Skirmish / Sandbox", "fight scenarios, a skirmish, or free flight"],
          ["Scenario editor", "build scenarios and play them, as a pilot or in strategy mode"],
          [
            "Crew",
            "officers: assign them to this design's posts (by class), edit names, traits, levels (chevrons) and portraits, generate crews with English, German, Japanese or mixed names, import your own name file, export or import the roster as JSON",
          ],
          ["F1 or ? or Help", "this help"],
        ],
      ],
    ],
  },
  "scenario-editor": {
    title: "Scenario editor",
    intro:
      "Place ships, asteroids, black holes and player spawns on the map, then watch, play or command it.",
    sections: [
      [
        "Placing",
        [
          [
            "Click a ship in the gallery",
            "pick it (team and AI type above the gallery); click on the map to place it",
          ],
          ["Press and drag when placing a ship", "turn it: the drag sets which way its attack front points"],
          ["AI “No AI”", "the ship stays where it is placed; its automatic weapons still fire"],
          ["Asteroid / Black hole / Player spawn", "pick the tool, then click on the map"],
          ["Esc", "back to Select / move"],
        ],
      ],
      [
        "Editing",
        [
          ["Click an item", "select it; its properties are on the right"],
          ["Drag an item", "move it"],
          ["Q / E", "rotate the selected ship, asteroid or spawn by 15°"],
          ["Delete / Backspace", "remove the selected item"],
          ["Ctrl+Z / Ctrl+Y", "undo / redo"],
          [
            "Right panel",
            "arena size, budget, objective, seed, flight model (Newtonian or arcade, for watch, play and command); problems that would stop the battle",
          ],
          ["Crew… (ship selected)", "officers of that ship"],
        ],
      ],
      [
        "View",
        [
          ["Mouse wheel", "zoom at the cursor"],
          ["Drag empty space", "pan"],
          ["View menu", "fit the arena, zoom in or out"],
        ],
      ],
      [
        "File and play",
        [
          [
            "File menu",
            "new, open (bundled, tuning tests, saved, GitHub folder), save in the browser, export JSON, import a JSON file (a scenario opens, a ship design goes to the library)",
          ],
          [
            "Crew",
            "officers of every ship, all sides: generate (names, trait strength and level fixed or random), copy from the roster, edit one, or leave random at start; saved with the scenario",
          ],
          ["Watch", "the AI flies every ship"],
          ["Play", "fly the ship open in the ship editor"],
          ["Command", "strategy mode: command the team-0 ships"],
          ["Black holes", "ships may orbit them; anything that enters the core is destroyed"],
          ["F1 or ? or Help", "this help"],
        ],
      ],
    ],
  },
  flight: {
    title: "Flight",
    intro: "Fly one ship; the rest of your fleet follows your orders under AI.",
    sections: [
      [
        "Flying",
        [
          ["W / S", "thrust forward / back"],
          ["A / D", "strafe left / right"],
          ["Q / E", "rotate"],
          ["F", "face the cursor"],
          ["X", "speed kill (Shift+X: flip and burn)"],
          ["C", "match the target's course and speed"],
          ["V", "also close to a distance and keep it; , and . change the distance"],
          ["Shift+V", "lock it: steering only pauses it (press again to unlock)"],
          ["I", "drive: all engines, ion only, chemical only"],
        ],
      ],
      [
        "Weapons",
        [
          ["Left mouse", "fire the selected weapon groups at the cursor"],
          ["1–9", "select a weapon group (Shift adds)"],
          ["G", "group mode: hold, manual, automatic"],
          ["Right click", "pick a target (or click a contact in the list)"],
          ["M / Shift+M", "launch a missile / a salvo"],
          ["Z", "missile type"],
          ["H / Shift+H", "launch a drone / all; U drone type"],
          ["O", "point defense also fires at ships"],
        ],
      ],
      [
        "Fleet",
        [
          ["Tab", "switch to the next ship"],
          ["J / K / L", "allies follow / attack my target / hold"],
          ["Ctrl+click a ship or contact", "pick allies for orders (Shift adds)"],
          ["Contacts panel", "help me, protect me, priority target, orders per ship"],
        ],
      ],
      [
        "Ship",
        [
          ["P", "power priority"],
          ["R", "radiators out / in"],
          ["N", "networks"],
          ["B / Shift+B", "eject mode (click a part) / eject all wrecks"],
        ],
      ],
      [
        "View and time",
        [
          ["Shift+C", "camera: follow with target, follow, free"],
          ["Mouse wheel / middle drag", "zoom / pan (free camera)"],
          ["Shift+T", "overlays"],
          ["T", "colour theme"],
          ["+ / − or ] / [", "time scale"],
          ["Space", "pause"],
          ["F1 or ? or Help", "this help"],
          ["Esc", "back to the editor"],
        ],
      ],
      [
        "Crew",
        [
          [
            "Strip above fire control",
            "officers of your ship: portrait, post, experience (stars) and what they add; the last card is the ship's total. Hover a card for its traits",
          ],
          ["Officers", "yours from the roster (Crew in the ship editor); enemy ships get random ones"],
        ],
      ],
    ],
  },
  strategy: {
    title: "Strategy",
    intro:
      "Command the scenario's team-0 ships like a real-time strategy game: select them, give orders, queue more. They fly and fight on their own under AI.",
    sections: [
      [
        "Selecting",
        [
          ["Click a ship", "select it (Shift adds or removes)"],
          ["Drag a box", "select every ship in it (Shift adds)"],
          ["Ctrl+A", "select all your ships"],
          ["Ctrl+1–9 / 1–9", "store the selection as a group / recall it"],
          ["Click a ship in the panel", "select it"],
          [
            "Details card",
            "the selected ship: damage schematic (point at a part), systems, fuel, heat, power, orders and munitions with time of fire left",
          ],
          ["Esc", "cancel the order being given, then clear the selection"],
        ],
      ],
      [
        "Orders",
        [
          ["Right click on the map", "move there (several ships spread around the point)"],
          [
            "Right press and drag",
            "move to the press point; the drag sets which way the attack front points on arrival",
          ],
          ["Right click on an enemy", "attack it"],
          ["Right click on your ship", "follow it"],
          ["Shift + any order", "queue it after the current orders instead of replacing them"],
          [
            "M, then click, then click again",
            "move there, then point the attack front towards the second click (Enter or right click: no facing)",
          ],
          ["A, then click an enemy", "attack"],
          ["P, then click waypoints", "patrol the path; Enter, P, a double click or a right click starts it"],
          ["P, then drag a box", "patrol round that area"],
          [
            "W, then click one of your ships",
            "wait: hold until that ship has arrived (no move orders left), then go on with the queue. With Shift it is queued: e.g. move, wait for A, then attack: when A arrives, B attacks",
          ],
          ["H", "hold where the ships are"],
          ["S", "stop: drop every order and hold"],
          ["AI type (panel)", "change how the selected ships fight"],
        ],
      ],
      [
        "Editing orders",
        [
          [
            "Drag a point of a selected ship's order",
            "move a move, hold or wait point, or a patrol waypoint",
          ],
          ["Drag a “+” between patrol waypoints", "add a waypoint there"],
          ["Double click a patrol waypoint", "remove it (a patrol keeps at least two)"],
          ["↑ / ↓ in the details card", "run an order earlier or later"],
          ["✕ in the details card", "remove a queued order; on the current one, skip to the next"],
          [
            "◎ on a move in the details card, then click",
            "aim that leg of the route: on the way the attack front turns to the point, whenever the main engine is not needed (◎✕ stops it)",
          ],
        ],
      ],
      [
        "Map and time",
        [
          ["Mouse wheel", "zoom at the cursor"],
          ["Right or middle drag", "pan"],
          ["Arrow keys", "scroll"],
          ["Home or Fit map", "show the whole arena"],
          ["Space", "pause"],
          ["+ / − or ] / [", "time scale"],
          ["F1 or ? or Help", "this help"],
        ],
      ],
      [
        "On the map",
        [
          ["Ring", "your ship; bright when selected"],
          ["Green line and dot", "move order and where it ends"],
          ["Blue loop", "patrol path"],
          ["Red line", "attack target"],
          ["Grey line", "follow or guard"],
          ["Square", "hold point"],
          ["Red arrow at a point", "facing: where the attack front points on arrival"],
          ["Orange dashed line", "aim of a route leg"],
          [
            "Symbols far out",
            "ship class: drone, fighter, corvette, frigate, destroyer, cruiser, battlecruiser, battleship; a dot marks missile ships, a bar carriers",
          ],
          [
            "Plot round the ship schematic",
            "where its weapons are strongest now (lost turrets change it) and its attack front",
          ],
          ["Yellow dotted line", "wait: to the ship being waited for"],
          ["Handles", "points of the selected ships' orders that can be dragged"],
          ["Faint lines", "orders of ships not selected"],
        ],
      ],
      [
        "Crew",
        [
          [
            "Strip along the bottom",
            "officers of the selected ship: post, experience and what they add, and the ship's total",
          ],
        ],
      ],
    ],
  },
};

/** The About page: what the game is, the author and the homepage. */
function aboutPage(): HTMLElement {
  return el(
    "div",
    { class: "help-body about", "data-testid": "help-about" },
    el("h3", {}, "Space Game"),
    el(
      "p",
      { class: "help-intro" },
      "Design ships from parts, fly them with Newtonian physics, and fight scenarios as a pilot or as a fleet commander.",
    ),
    el("p", {}, COPYRIGHT),
    el("p", {}, "Homepage: ", creditLink(HOMEPAGE)),
  );
}

export class HelpDialog {
  private readonly dialog: HTMLDialogElement;
  private topic: HelpTopic | "about" = "flight";

  constructor() {
    this.dialog = el("dialog", {
      class: "ed-dialog help-dialog",
      "data-testid": "help-dialog",
    }) as HTMLDialogElement;
    document.body.append(this.dialog);
    this.dialog.addEventListener("keydown", (e) => {
      if (e.key === "F1" || e.key === "?") {
        e.preventDefault();
        this.close();
      }
    });
  }

  get open(): boolean {
    return this.dialog.open;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** Opens on `topic` (the screen in use, or the About page); the tabs show the others. Pressing it again closes it. */
  show(topic: HelpTopic | "about"): void {
    if (this.dialog.open && this.topic === topic) return this.close();
    this.topic = topic;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private render(): void {
    const tabs = el("div", { class: "help-tabs", role: "tablist" });
    for (const t of Object.keys(HELP) as HelpTopic[]) {
      const b = el(
        "button",
        {
          role: "tab",
          "data-testid": `help-tab-${t}`,
          class: t === this.topic ? "on" : "",
          "aria-selected": String(t === this.topic),
        },
        HELP[t].title,
      );
      b.addEventListener("click", () => {
        this.topic = t;
        this.render();
      });
      tabs.append(b);
    }
    const about = el(
      "button",
      {
        role: "tab",
        "data-testid": "help-tab-about",
        class: this.topic === "about" ? "on" : "",
        "aria-selected": String(this.topic === "about"),
      },
      "About",
    );
    about.addEventListener("click", () => {
      this.topic = "about";
      this.render();
    });
    tabs.append(about);
    const close = el("button", { "data-testid": "help-close" }, "Close");
    close.addEventListener("click", () => this.close());
    const footer = el("div", { class: "actions help-footer" }, creditLink(), close);
    if (this.topic === "about") {
      this.dialog.replaceChildren(el("h2", {}, "Help"), tabs, aboutPage(), footer);
      return;
    }
    const h = HELP[this.topic];
    const body = el(
      "div",
      { class: "help-body", "data-testid": `help-${this.topic}` },
      el("p", { class: "help-intro" }, h.intro),
    );
    for (const [title, rows] of h.sections) {
      const table = el("table", { class: "help-table" });
      for (const [keys, what] of rows) table.append(el("tr", {}, el("th", {}, keys), el("td", {}, what)));
      body.append(el("section", {}, el("h3", {}, title), table));
    }
    this.dialog.replaceChildren(el("h2", {}, "Help"), tabs, body, footer);
  }
}
