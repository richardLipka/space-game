import type { PortraitPart, PortraitSpec } from "../data/schemas/officer";
import { PORTRAIT_COUNTS } from "../sim/crew/officers";

/**
 * Schematic officer portraits (docs/officers.md): flat SVG drawn from interchangeable parts, each picked by
 * index (head shape, skin, hair or headgear, eyes or goggles, mouth, moustache or beard, neck and tie,
 * uniform and its colour, collar, an accessory, and an optional space suit). Pseudo-Victorian and
 * mechanical pieces: top hats, monocles, brass goggles, cog medals, mechanical eyes.
 */

export const SKIN = [
  "#f2d3b1",
  "#e0b48a",
  "#c68c5c",
  "#9c6640",
  "#6e4528",
  "#b7c7c9",
  "#fbe6d4",
  "#b39066",
  "#c99a3b",
];
export const HAIR = [
  "#2b2118",
  "#5a3a22",
  "#9b6a3c",
  "#d9b46a",
  "#b8b8b8",
  "#7a1f1f",
  "#2f3e5c",
  "#efeee8",
  "#c2571f",
  "#e8e2c0",
  "#6b3c7a",
];
export const CLOTH = [
  "#24324a",
  "#4a1f24",
  "#2d4a33",
  "#4a4a4a",
  "#5b3b1c",
  "#e0dccf",
  "#17171b",
  "#1f4a4a",
  "#3a2450",
  "#8a6a1c",
];
const BRASS = "#c99a3b";
const BRASS_DARK = "#8a6420";
const STEEL = "#8d99a3";
const LINE = "#1b1b1b";

export const PART_LABELS: Record<PortraitPart, readonly string[]> = {
  head: ["Oval", "Square jaw", "Round", "Long", "Heart", "Wide", "Angular"],
  skin: ["Fair", "Light", "Tan", "Brown", "Dark", "Android", "Pale", "Olive", "Brass automaton"],
  hair: [
    "Bald",
    "Short crop",
    "Side part",
    "Long",
    "Bun",
    "Mohawk",
    "Flight helmet",
    "Top hat",
    "Brass helmet",
    "Curly",
    "Ponytail",
    "Slicked back",
    "Peaked cap",
    "Bowler hat",
    "Pith helmet",
    "Colonial white cap",
    "Modern cap",
    "Kaisermarine cap",
  ],
  hairColor: [
    "Black",
    "Brown",
    "Chestnut",
    "Blond",
    "Grey",
    "Auburn",
    "Blue",
    "White",
    "Ginger",
    "Platinum",
    "Violet",
  ],
  eyes: [
    "Plain",
    "With brows",
    "Narrow",
    "Brass goggles",
    "Monocle",
    "Mechanical eye",
    "Spectacles",
    "Eyepatch",
    "Visor",
    "Pince-nez",
    "Tired",
    "Wide-eyed",
    "Welding goggles",
  ],
  mouth: ["Neutral", "Smile", "Frown", "Open", "Smirk", "Grin", "Pursed", "Speaker grille", "Cigar"],
  facialHair: [
    "None",
    "Handlebar moustache",
    "Thin moustache",
    "Full beard",
    "Mutton chops",
    "Goatee",
    "Stubble",
    "Walrus moustache",
    "Imperial",
    "Chin strap",
    "Van Dyke",
  ],
  neck: [
    "Plain",
    "Tie",
    "Bow tie",
    "Cravat",
    "Scarf",
    "Ascot with pin",
    "Neck order",
    "Brass gorget",
    "Neck brace",
  ],
  uniform: [
    "Jacket",
    "Double-breasted",
    "Flight suit",
    "Coat with sash",
    "Armour plates",
    "Waistcoat",
    "Engineer overalls",
    "Cape",
    "Hussar frogging",
    "Exo-frame",
    "Colonial whites",
    "Modern, metal stripes",
    "Kaisermarine tunic",
  ],
  uniformColor: ["Navy", "Crimson", "Green", "Grey", "Brown", "Ivory", "Black", "Teal", "Purple", "Mustard"],
  collar: [
    "None",
    "High collar",
    "Wing collar",
    "Lapels",
    "Fur collar",
    "Mandarin",
    "Ruff",
    "Pinned collar",
    "Hood",
    "Colonial stand collar",
    "Kaiser high collar",
    "Metal collar tabs",
  ],
  accessory: [
    "None",
    "Epaulettes",
    "Cog medal",
    "Headset",
    "Pipe",
    "Scar",
    "Brass shoulder gear",
    "Watch chain",
    "Cog earring",
    "Aiguillette",
    "Gas mask",
    "Ribbon bar",
    "Circuit tattoo",
    "Piston shoulder",
    "Bandage",
  ],
};

const at = <T>(xs: readonly T[], i: number): T => xs[((i % xs.length) + xs.length) % xs.length]!;

/** Head outline (centre 50,46). */
function head(i: number, skin: string): string {
  const shapes = [
    `<ellipse cx="50" cy="46" rx="17" ry="21"/>`,
    `<path d="M33 34 Q33 24 50 24 Q67 24 67 34 L66 56 Q60 67 50 67 Q40 67 34 56 Z"/>`,
    `<circle cx="50" cy="46" r="19"/>`,
    `<ellipse cx="50" cy="45" rx="15" ry="23"/>`,
    `<path d="M32 38 Q32 24 50 24 Q68 24 68 38 Q68 56 50 68 Q32 56 32 38 Z"/>`,
    `<ellipse cx="50" cy="47" rx="20" ry="19"/>`,
    `<path d="M34 30 L50 24 L66 30 L66 54 L50 68 L34 54 Z"/>`,
  ];
  return `<g fill="${skin}" stroke="${LINE}" stroke-width="1.2"><ellipse cx="32.5" cy="47" rx="3" ry="5"/><ellipse cx="67.5" cy="47" rx="3" ry="5"/>${at(shapes, i)}</g>`;
}

function hair(i: number, c: string): string {
  const s = `fill="${c}" stroke="${LINE}" stroke-width="1"`;
  switch (((i % 18) + 18) % 18) {
    case 0:
      return "";
    case 15:
      // British colonial navy: white-topped peaked cap, black band, gold badge, black visor.
      return `<g stroke="${LINE}" stroke-width="1"><path fill="#f6f4ee" d="M29 33 Q31 15 50 15 Q69 15 71 33 Z"/><rect x="31" y="29" width="38" height="5.5" fill="#15151a"/><path fill="#0d0d10" d="M32 34.5 Q50 42 68 34.5 Z"/></g><ellipse cx="50" cy="31.7" rx="4" ry="2.4" fill="${BRASS}" stroke="${BRASS_DARK}" stroke-width="0.6"/><path d="M46 30 Q50 26.5 54 30" stroke="${BRASS}" stroke-width="0.9" fill="none"/>`;
    case 16:
      // Modern: soft cap tilted, metal badge with stripes.
      return `<g stroke="${LINE}" stroke-width="1"><path fill="#2a2f36" d="M30 35 Q27 19 47 17 Q69 15 72 29 Q66 31 59 33 Q46 37 30 35 Z"/><path d="M30 35 Q50 39 67 32" fill="none" stroke="#14171b" stroke-width="2"/></g><rect x="35" y="23" width="8" height="8" rx="1" fill="${STEEL}" stroke="${LINE}" stroke-width="0.6"/><path d="M36.5 25.5 L41.5 25.5 M36.5 27.5 L41.5 27.5 M36.5 29.5 L41.5 29.5" stroke="#e8eef2" stroke-width="0.8"/>`;
    case 17:
      // Kaisermarine: dark peaked cap with a wide crown, black band, cockade and gold crown.
      return `<g stroke="${LINE}" stroke-width="1"><path fill="#1b2233" d="M26 25 Q50 12 74 25 L69 33 L31 33 Z"/><rect x="32" y="29" width="36" height="5.5" fill="#0f0f12"/><path fill="#0d0d10" d="M33 34.5 Q50 41 67 34.5 Z"/></g><circle cx="50" cy="31.7" r="2.6" fill="#b22222"/><circle cx="50" cy="31.7" r="1.7" fill="#f4f4f4"/><circle cx="50" cy="31.7" r="0.9" fill="#111"/><path d="M46.5 25 L47.5 21.5 L50 23.5 L52.5 21.5 L53.5 25 Z" fill="${BRASS}" stroke="${BRASS_DARK}" stroke-width="0.4"/>`;
    case 9:
      // Curly.
      return `<g ${s}>${[
        [34, 38],
        [36, 30],
        [42, 25],
        [50, 23],
        [58, 25],
        [64, 30],
        [66, 38],
      ]
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.5"/>`)
        .join("")}</g>`;
    case 10:
      return `<g ${s}><path d="M63 34 Q77 44 71 68 Q66 54 61 40 Z"/><path d="M33 40 Q34 25 50 24 Q66 25 67 40 Q60 31 50 31 Q40 31 33 40 Z"/><rect x="63" y="38" width="5" height="3" fill="${BRASS}"/></g>`;
    case 11:
      return `<g><path ${s} d="M33 42 Q32 22 50 22 Q68 22 67 42 Q64 28 50 27 Q36 28 33 42 Z"/><path d="M40 25.5 Q50 23 60 25.5" stroke="#ffffff" stroke-opacity="0.35" fill="none"/></g>`;
    case 12:
      // Officer's peaked cap.
      return `<g stroke="${LINE}" stroke-width="1"><path fill="#24324a" d="M31 34 Q33 17 50 17 Q67 17 69 34 Z"/><rect x="32" y="30" width="36" height="5" fill="#1d1d22"/><path fill="#111" d="M33 35 Q50 42 67 35 Z"/></g><g stroke="${LINE}" stroke-width="0.5">${cog(50, 25, 3.2, BRASS)}</g>`;
    case 13:
      // Bowler hat.
      return `<g fill="#1d1d22" stroke="${LINE}" stroke-width="1"><path d="M35 31 Q34 13 50 13 Q66 13 65 31 Z"/><path d="M26 32 Q50 25 74 32 Q74 35 70 34 Q50 30 30 34 Q26 35 26 32 Z"/><rect x="35" y="26" width="30" height="3" fill="#5b3b1c"/></g>`;
    case 14:
      // Pith helmet.
      return `<g stroke="${LINE}" stroke-width="1"><path fill="#e6dcc0" d="M31 35 Q31 13 50 13 Q69 13 69 35 Z"/><path fill="#d3c59f" d="M23 37 Q50 28 77 37 L75 40 Q50 33 25 40 Z"/><rect x="31" y="31" width="38" height="3" fill="#8a6a1c"/><circle cx="50" cy="12" r="2" fill="${BRASS}"/></g>`;
    case 1:
      return `<path ${s} d="M33 40 Q34 25 50 24 Q66 25 67 40 Q60 31 50 31 Q40 31 33 40 Z"/>`;
    case 2:
      return `<path ${s} d="M32 44 Q31 24 50 23 Q69 24 68 44 Q64 30 54 30 Q46 33 40 30 Q35 34 32 44 Z"/>`;
    case 3:
      return `<path ${s} d="M31 62 Q26 24 50 22 Q74 24 69 62 L65 62 Q66 34 50 31 Q34 34 35 62 Z"/>`;
    case 4:
      return `<g ${s}><circle cx="50" cy="20" r="6"/><path d="M33 40 Q34 25 50 24 Q66 25 67 40 Q60 30 50 30 Q40 30 33 40 Z"/></g>`;
    case 5:
      return `<path ${s} d="M46 31 L47 15 L50 13 L53 15 L54 31 Z"/>`;
    case 6:
      // Leather flight helmet with goggles on the brow.
      return `<g><path fill="#6b4a2b" stroke="${LINE}" stroke-width="1" d="M31 50 Q30 22 50 22 Q70 22 69 50 L66 50 Q66 31 50 30 Q34 31 34 50 Z"/><rect x="36" y="30" width="28" height="5" fill="${BRASS_DARK}"/><circle cx="43" cy="32" r="4.5" fill="${BRASS}" stroke="${LINE}"/><circle cx="57" cy="32" r="4.5" fill="${BRASS}" stroke="${LINE}"/><circle cx="43" cy="32" r="2.5" fill="#8fd3ff"/><circle cx="57" cy="32" r="2.5" fill="#8fd3ff"/></g>`;
    case 7:
      // Top hat.
      return `<g fill="#1d1d22" stroke="${LINE}" stroke-width="1"><rect x="27" y="25" width="46" height="4" rx="1"/><rect x="36" y="4" width="28" height="22" rx="1"/><rect x="36" y="20" width="28" height="3" fill="#7a1f1f"/></g>`;
    default:
      // Riveted brass helmet.
      return `<g><path fill="${BRASS}" stroke="${LINE}" stroke-width="1" d="M30 46 Q29 20 50 19 Q71 20 70 46 L66 46 Q66 30 50 29 Q34 30 34 46 Z"/>${[
        36, 43, 50, 57, 64,
      ]
        .map(
          (x) =>
            `<circle cx="${x}" cy="${x === 50 ? 21 : x === 43 || x === 57 ? 22.5 : 26}" r="1.1" fill="${BRASS_DARK}"/>`,
        )
        .join("")}<rect x="47" y="12" width="6" height="8" fill="${STEEL}" stroke="${LINE}"/></g>`;
  }
}

function eyes(i: number): string {
  const pupils = `<circle cx="43" cy="44" r="1.8" fill="${LINE}"/><circle cx="57" cy="44" r="1.8" fill="${LINE}"/>`;
  switch (((i % 13) + 13) % 13) {
    case 0:
      return pupils;
    case 7:
      return `<circle cx="43" cy="44" r="1.8" fill="${LINE}"/><path d="M33 33 L68 51" stroke="${LINE}" stroke-width="1"/><ellipse cx="57" cy="44" rx="5.5" ry="4.5" fill="#1d1d22"/>`;
    case 8:
      return `<rect x="34" y="40" width="32" height="8" rx="3.5" fill="#2a2f36" stroke="${LINE}"/><rect x="36" y="42.5" width="28" height="3" rx="1.5" fill="#ff5a3b"/>`;
    case 9:
      return `${pupils}<g fill="none" stroke="${BRASS_DARK}" stroke-width="1"><circle cx="43" cy="44" r="3.6"/><circle cx="57" cy="44" r="3.6"/><path d="M46.6 43 Q50 41 53.4 43"/><path d="M39.4 45 Q35 58 38 70" stroke-width="0.6"/></g>`;
    case 10:
      return `${pupils}<path d="M40 47.6 Q43 49.8 46 47.6 M54 47.6 Q57 49.8 60 47.6" stroke="${LINE}" stroke-width="0.7" fill="none" opacity="0.7"/><path d="M39 41 L47 41.5 M53 41.5 L61 41" stroke="${LINE}" stroke-width="1.2"/>`;
    case 11:
      return `<g stroke="${LINE}" stroke-width="0.8"><circle cx="43" cy="44" r="3.4" fill="#ffffff"/><circle cx="57" cy="44" r="3.4" fill="#ffffff"/></g><circle cx="43" cy="44" r="1.6" fill="${LINE}"/><circle cx="57" cy="44" r="1.6" fill="${LINE}"/>`;
    case 12:
      return `<g stroke="${LINE}" stroke-width="1"><rect x="31" y="41" width="38" height="3" fill="#3a2a1a"/><rect x="37" y="39" width="11" height="9" rx="2" fill="${STEEL}"/><rect x="52" y="39" width="11" height="9" rx="2" fill="${STEEL}"/><rect x="39" y="41" width="7" height="5" fill="#1f2a1f"/><rect x="54" y="41" width="7" height="5" fill="#1f2a1f"/></g>`;
    case 1:
      return `${pupils}<path d="M39 39 L47 38 M53 38 L61 39" stroke="${LINE}" stroke-width="1.6" fill="none"/>`;
    case 2:
      return `<path d="M39 44 L47 44 M53 44 L61 44" stroke="${LINE}" stroke-width="2" fill="none"/><path d="M39 40 L47 41 M53 41 L61 40" stroke="${LINE}" stroke-width="1.4" fill="none"/>`;
    case 3:
      return `<g stroke="${LINE}" stroke-width="1"><rect x="34" y="40.5" width="32" height="3" fill="${BRASS_DARK}"/><circle cx="43" cy="44" r="5.5" fill="${BRASS}"/><circle cx="57" cy="44" r="5.5" fill="${BRASS}"/><circle cx="43" cy="44" r="3.4" fill="#7fe0c8"/><circle cx="57" cy="44" r="3.4" fill="#7fe0c8"/></g>`;
    case 4:
      return `${pupils}<circle cx="57" cy="44" r="4.5" fill="none" stroke="${BRASS}" stroke-width="1.4"/><path d="M61 46 Q66 56 63 66" stroke="${BRASS}" stroke-width="0.8" fill="none"/>`;
    case 5:
      return `<circle cx="43" cy="44" r="1.8" fill="${LINE}"/><g stroke="${LINE}" stroke-width="0.8"><circle cx="57" cy="44" r="5.5" fill="${STEEL}"/><circle cx="57" cy="44" r="3" fill="#ff3b3b"/>${[
        0, 60, 120, 180, 240, 300,
      ]
        .map((a) => {
          const r = (a * Math.PI) / 180;
          return `<rect x="${(57 + Math.cos(r) * 6.2 - 0.9).toFixed(1)}" y="${(44 + Math.sin(r) * 6.2 - 0.9).toFixed(1)}" width="1.8" height="1.8" fill="${STEEL}"/>`;
        })
        .join("")}</g>`;
    default:
      return `${pupils}<g fill="none" stroke="${LINE}" stroke-width="1.2"><circle cx="43" cy="44" r="4.5"/><circle cx="57" cy="44" r="4.5"/><path d="M47.5 44 L52.5 44"/></g>`;
  }
}

function mouth(i: number): string {
  const line = (d: string, fill = "none") =>
    `<path d="${d}" stroke="${LINE}" stroke-width="1.6" fill="${fill}" stroke-linecap="round"/>`;
  const shapes = [
    line("M44 57 L56 57"),
    line("M43 56 Q50 61 57 56"),
    line("M43 59 Q50 54 57 59"),
    line("M45 56 Q50 62 55 56 Z", "#5a1f1f"),
    line("M44 57 Q52 59 57 55"),
    `${line("M42 55.5 Q50 63 58 55.5 Z", "#ffffff")}<path d="M43 56.5 L57 56.5" stroke="${LINE}" stroke-width="0.6"/>`,
    line("M48 57 Q50 55 52 57 Q50 59 48 57 Z", "#7a3b3b"),
    `<rect x="43" y="54" width="14" height="7" rx="1.5" fill="${STEEL}" stroke="${LINE}"/><path d="M45 55.5 L55 55.5 M45 57.5 L55 57.5 M45 59.5 L55 59.5" stroke="${LINE}" stroke-width="0.8"/>`,
    `${line("M44 57 L54 57")}<rect x="54" y="55.6" width="12" height="3" rx="1" fill="#6b4a2b" stroke="${LINE}" stroke-width="0.6"/><circle cx="66.5" cy="57.1" r="1.4" fill="#ff7a2b"/>`,
  ];
  return at(shapes, i);
}

function facialHair(i: number, c: string): string {
  const s = `fill="${c}" stroke="${LINE}" stroke-width="0.8"`;
  switch (((i % 11) + 11) % 11) {
    case 0:
      return "";
    case 7:
      return `<path ${s} d="M38 53 Q50 47 62 53 Q63 61 56 59 Q50 57 44 59 Q37 61 38 53 Z"/>`;
    case 8:
      return `<g ${s}><path d="M50 53 Q43 51 37 48 Q40 55 50 54.5 Q60 55 63 48 Q57 51 50 53 Z"/><path d="M47.5 62 L50 70 L52.5 62 Z"/></g>`;
    case 9:
      return `<path ${s} d="M33 46 Q35 68 50 70 Q65 68 67 46 Q64 64 50 66 Q36 64 33 46 Z"/>`;
    case 10:
      return `<g ${s}><path d="M43 54 Q50 51 57 54 Q50 53 43 54 Z"/><path d="M45 61 Q50 72 55 61 Q50 63 45 61 Z"/></g>`;
    case 1:
      return `<path ${s} d="M50 53 Q44 51 39 55 Q35 55 35 51 Q39 56 44 53 Q48 52 50 53 Q52 52 56 53 Q61 56 65 51 Q65 55 61 55 Q56 51 50 53 Z"/>`;
    case 2:
      return `<path ${s} d="M43 54 Q50 51 57 54 Q50 53 43 54 Z"/>`;
    case 3:
      return `<path ${s} d="M33 48 Q34 70 50 72 Q66 70 67 48 Q64 62 57 61 Q50 64 43 61 Q36 62 33 48 Z"/>`;
    case 4:
      return `<g ${s}><path d="M33 44 Q32 62 41 60 Q37 54 37 44 Z"/><path d="M67 44 Q68 62 59 60 Q63 54 63 44 Z"/></g>`;
    case 5:
      return `<path ${s} d="M45 61 Q50 70 55 61 Q50 63 45 61 Z"/>`;
    default:
      return `<path fill="${c}" opacity="0.35" d="M35 50 Q36 66 50 68 Q64 66 65 50 Q60 60 50 61 Q40 60 35 50 Z"/>`;
  }
}

function body(spec: PortraitSpec, cloth: string, skin: string): string {
  const u = ((spec.uniform % 13) + 13) % 13;
  // Colonial whites are always white; the closed tunics (10–12) hide the shirt.
  const coat = u === 10 ? "#f4f1e8" : cloth;
  const shoulders = `<path fill="${coat}" stroke="${LINE}" stroke-width="1.2" d="M14 120 Q14 86 36 80 L64 80 Q86 86 86 120 Z"/>`;
  const neckSkin = `<rect x="44" y="64" width="12" height="18" fill="${skin}" stroke="${LINE}" stroke-width="1"/>`;
  const shirt =
    u >= 10 ? "" : `<path fill="#f2efe6" stroke="${LINE}" stroke-width="1" d="M42 80 L50 96 L58 80 Z"/>`;
  let extra = "";
  if (u === 1)
    extra = [88, 96, 104]
      .flatMap((y) => [
        `<circle cx="40" cy="${y}" r="1.6" fill="${BRASS}"/>`,
        `<circle cx="60" cy="${y}" r="1.6" fill="${BRASS}"/>`,
      ])
      .join("");
  else if (u === 2)
    extra = `<g stroke="#3a2a1a" stroke-width="3"><path d="M30 84 L40 120"/><path d="M70 84 L60 120"/></g><rect x="45" y="104" width="10" height="7" fill="${STEEL}" stroke="${LINE}"/>`;
  else if (u === 3) extra = `<path d="M30 84 L70 116" stroke="#c9a23b" stroke-width="5"/>`;
  else if (u === 4)
    extra = `<g fill="${STEEL}" stroke="${LINE}" stroke-width="1"><path d="M18 100 Q22 86 36 82 L38 96 Z"/><path d="M82 100 Q78 86 64 82 L62 96 Z"/><rect x="40" y="98" width="20" height="14" rx="2"/></g><g fill="${BRASS_DARK}"><circle cx="43" cy="101" r="1"/><circle cx="57" cy="101" r="1"/><circle cx="43" cy="109" r="1"/><circle cx="57" cy="109" r="1"/></g>`;
  else if (u === 5)
    extra =
      `<path fill="#3b2a1a" stroke="${LINE}" stroke-width="1" d="M38 82 L50 104 L62 82 L63 120 L37 120 Z"/>` +
      [104, 110, 116].map((y) => `<circle cx="50" cy="${y}" r="1.4" fill="${BRASS}"/>`).join("");
  else if (u === 6)
    extra = `<g stroke="${LINE}" stroke-width="1"><path d="M38 97 L36 81 M62 97 L64 81" stroke="#4d5f70" stroke-width="4"/><rect x="37" y="96" width="26" height="24" fill="#4d5f70"/><rect x="44" y="102" width="12" height="8" fill="none" stroke="#2d3a44"/></g><circle cx="39" cy="98" r="1.6" fill="${BRASS}"/><circle cx="61" cy="98" r="1.6" fill="${BRASS}"/>`;
  else if (u === 7)
    extra = `<path fill="#141418" fill-opacity="0.9" stroke="${LINE}" stroke-width="1" d="M10 120 Q12 88 32 80 L36 120 Z M90 120 Q88 88 68 80 L64 120 Z"/><path d="M34 84 Q50 90 66 84" stroke="${BRASS}" stroke-width="1" fill="none"/><circle cx="34" cy="84" r="2.4" fill="${BRASS}"/><circle cx="66" cy="84" r="2.4" fill="${BRASS}"/>`;
  else if (u === 8)
    extra = [90, 96, 102, 108, 114]
      .map(
        (y) => `<path d="M38 ${y} Q50 ${y + 2} 62 ${y}" stroke="${BRASS}" stroke-width="1.4" fill="none"/>`,
      )
      .join("");
  else if (u === 9)
    extra = `<g stroke="${STEEL}" stroke-width="3" fill="none" stroke-linecap="round"><path d="M22 120 L27 92 L38 84"/><path d="M78 120 L73 92 L62 84"/></g><g stroke="${LINE}" stroke-width="0.5">${cog(27, 92, 4, BRASS)}${cog(73, 92, 4, BRASS)}</g>`;
  else if (u === 10)
    // British colonial navy whites: single row of gold buttons, black shoulder boards with gold stripes.
    extra =
      `<path d="M50 82 L50 120" stroke="#c9c4b4" stroke-width="1"/>` +
      [94, 101, 108, 115]
        .map(
          (y) =>
            `<circle cx="50" cy="${y}" r="1.5" fill="${BRASS}" stroke="${BRASS_DARK}" stroke-width="0.4"/>`,
        )
        .join("") +
      `<g stroke="${LINE}" stroke-width="0.6"><rect x="20" y="84" width="17" height="6" rx="1.5" fill="#15151a" transform="rotate(-14 28 87)"/><rect x="63" y="84" width="17" height="6" rx="1.5" fill="#15151a" transform="rotate(14 72 87)"/></g>` +
      `<g stroke="${BRASS}" stroke-width="0.9"><path d="M22 88.5 L35 85.2 M22.6 90.4 L35.6 87.1"/><path d="M78 88.5 L65 85.2 M77.4 90.4 L64.4 87.1"/></g>`;
  else if (u === 11)
    // Modern: zipped seam, metal stripes on the shoulders and a metal rank plate on the chest.
    extra =
      `<path d="M47 82 L53 120" stroke="#0e1114" stroke-width="1.4"/>` +
      `<g fill="${STEEL}" stroke="${LINE}" stroke-width="0.4">${[0, 1, 2]
        .flatMap((k) => [
          `<rect x="${21 + k * 4}" y="${88 - k * 1.4}" width="2.4" height="8" transform="rotate(-20 ${22 + k * 4} ${92 - k * 1.4})"/>`,
          `<rect x="${76.6 - k * 4}" y="${88 - k * 1.4}" width="2.4" height="8" transform="rotate(20 ${78 - k * 4} ${92 - k * 1.4})"/>`,
        ])
        .join(
          "",
        )}<rect x="57" y="92" width="15" height="2.4"/><rect x="57" y="96" width="15" height="2.4"/><rect x="57" y="100" width="11" height="2.4"/></g>`;
  else if (u === 12)
    // Kaisermarine: double-breasted dark tunic, two converging rows of gold buttons, braided shoulder straps.
    extra =
      [88, 95, 102, 109]
        .flatMap((y, k) => [
          `<circle cx="${39 + k * 1.2}" cy="${y}" r="1.7" fill="${BRASS}" stroke="${BRASS_DARK}" stroke-width="0.4"/>`,
          `<circle cx="${61 - k * 1.2}" cy="${y}" r="1.7" fill="${BRASS}" stroke="${BRASS_DARK}" stroke-width="0.4"/>`,
        ])
        .join("") +
      `<path d="M44 82 L48 120" stroke="#0e1320" stroke-width="1"/>` +
      `<g fill="none" stroke="${BRASS}" stroke-width="1.6"><path d="M21 90 Q28 84 36 83"/><path d="M79 90 Q72 84 64 83"/></g><g fill="none" stroke="#f0e2b0" stroke-width="0.6" stroke-dasharray="1 1"><path d="M21 90 Q28 84 36 83"/><path d="M79 90 Q72 84 64 83"/></g>`;
  return neckSkin + shoulders + shirt + extra;
}

function neckwear(i: number): string {
  switch (((i % 9) + 9) % 9) {
    case 5:
      return `<path fill="#4a1f5a" stroke="${LINE}" stroke-width="0.8" d="M44 80 Q50 86 56 80 Q58 90 50 96 Q42 90 44 80 Z"/><circle cx="50" cy="88" r="1.8" fill="${BRASS}" stroke="${LINE}" stroke-width="0.5"/>`;
    case 6:
      return `<path d="M41 79 L50 92 L59 79" stroke="#7a1f1f" stroke-width="2.6" fill="none"/><g stroke="${LINE}" stroke-width="0.5">${cog(50, 95, 3.6, BRASS)}</g>`;
    case 7:
      return `<path fill="${BRASS}" stroke="${LINE}" stroke-width="0.8" d="M37 81 Q50 96 63 81 L60 79 Q50 89 40 79 Z"/>`;
    case 8:
      return `<g fill="${STEEL}" stroke="${LINE}" stroke-width="0.8"><rect x="42" y="67" width="16" height="4" rx="1"/><rect x="42" y="73" width="16" height="4" rx="1"/></g><g fill="${BRASS_DARK}"><circle cx="44" cy="69" r="0.8"/><circle cx="56" cy="69" r="0.8"/><circle cx="44" cy="75" r="0.8"/><circle cx="56" cy="75" r="0.8"/></g>`;
    case 1:
      return `<path fill="#7a1f1f" stroke="${LINE}" stroke-width="0.8" d="M48 81 L52 81 L54 98 L50 103 L46 98 Z"/>`;
    case 2:
      return `<path fill="#1d1d22" stroke="${LINE}" stroke-width="0.8" d="M50 84 L42 80 L42 88 Z M50 84 L58 80 L58 88 Z"/>`;
    case 3:
      return `<path fill="#e8e2d0" stroke="${LINE}" stroke-width="0.8" d="M44 80 Q50 86 56 80 Q58 90 50 96 Q42 90 44 80 Z"/>`;
    case 4:
      return `<path fill="#c9a23b" stroke="${LINE}" stroke-width="0.8" d="M40 78 Q50 86 60 78 L62 84 Q50 92 38 84 Z"/>`;
    default:
      return "";
  }
}

function collar(i: number, cloth: string): string {
  switch (((i % 12) + 12) % 12) {
    case 9:
      // Colonial whites: white stand collar edged in gold.
      return `<path fill="#f4f1e8" stroke="${BRASS}" stroke-width="1" d="M40 71 L60 71 L61 82 L39 82 Z"/><circle cx="41.5" cy="76.5" r="1.1" fill="${BRASS}"/><circle cx="58.5" cy="76.5" r="1.1" fill="${BRASS}"/>`;
    case 10:
      // Kaiserliche Marine: tall dark collar with gold embroidery.
      return `<path fill="${cloth}" stroke="${BRASS}" stroke-width="1.2" d="M39 68 L61 68 L62.5 82 L37.5 82 Z"/><g stroke="${BRASS}" stroke-width="0.8" fill="none"><path d="M40.5 72 Q43 70 45.5 72 Q43 74 40.5 72 M40.5 77 Q43 75 45.5 77 Q43 79 40.5 77"/><path d="M59.5 72 Q57 70 54.5 72 Q57 74 59.5 72 M59.5 77 Q57 75 54.5 77 Q57 79 59.5 77"/></g>`;
    case 11:
      // Modern: closed band collar with metal tabs.
      return `<path fill="${cloth}" stroke="${LINE}" stroke-width="1" d="M41 73 L59 73 L60 82 L40 82 Z"/><g fill="${STEEL}" stroke="${LINE}" stroke-width="0.4"><rect x="41.5" y="75" width="5" height="4"/><rect x="53.5" y="75" width="5" height="4"/></g><path d="M42.5 77 L45.5 77 M54.5 77 L57.5 77" stroke="#e8eef2" stroke-width="0.6"/>`;
    case 5:
      return `<path fill="${cloth}" stroke="${BRASS}" stroke-width="1" d="M41 74 L59 74 L60 82 L40 82 Z"/>`;
    case 6:
      return `<g fill="#f5f2ea" stroke="${LINE}" stroke-width="0.6">${[34, 39, 44, 50, 56, 61, 66]
        .map((x) => `<circle cx="${x}" cy="80" r="4"/>`)
        .join("")}</g>`;
    case 7:
      return `<path fill="${cloth}" stroke="${LINE}" stroke-width="1" d="M38 78 L44 70 L46 84 Z M62 78 L56 70 L54 84 Z"/><circle cx="42" cy="76" r="1.3" fill="${BRASS}"/><circle cx="58" cy="76" r="1.3" fill="${BRASS}"/>`;
    case 8:
      return `<path fill="${cloth}" stroke="${LINE}" stroke-width="1" d="M27 86 Q22 36 50 26 Q78 36 73 86 Z"/>`;
    case 1:
      return `<path fill="${cloth}" stroke="${LINE}" stroke-width="1" d="M38 78 L44 70 L46 84 Z M62 78 L56 70 L54 84 Z"/>`;
    case 2:
      return `<path fill="#f2efe6" stroke="${LINE}" stroke-width="1" d="M44 78 L50 82 L44 86 Z M56 78 L50 82 L56 86 Z"/>`;
    case 3:
      return `<path fill="${cloth}" stroke="${LINE}" stroke-width="1" d="M36 81 L44 81 L48 100 Z M64 81 L56 81 L52 100 Z"/>`;
    case 4:
      return `<path fill="#d9cbb0" stroke="${LINE}" stroke-width="1" d="M30 84 Q50 74 70 84 Q66 90 60 86 Q50 82 40 86 Q34 90 30 84 Z"/>`;
    default:
      return "";
  }
}

function accessory(i: number): string {
  switch (((i % 15) + 15) % 15) {
    case 9:
      return `<path d="M67 84 Q63 98 54 100 M69 86 Q65 104 56 106" stroke="${BRASS}" stroke-width="1.4" fill="none"/><circle cx="54" cy="100" r="1.2" fill="${BRASS}"/><circle cx="56" cy="106" r="1.2" fill="${BRASS}"/>`;
    case 10:
      return `<g stroke="${LINE}" stroke-width="0.8"><path d="M40 92 Q50 98 60 92" stroke="#3a3a3a" stroke-width="1.4" fill="none"/><ellipse cx="50" cy="106" rx="9" ry="7" fill="#4a4a4a"/><circle cx="45" cy="106" r="3" fill="${BRASS_DARK}"/><circle cx="55" cy="106" r="3" fill="${BRASS_DARK}"/><rect x="47" y="110" width="6" height="5" fill="#2e2e2e"/></g>`;
    case 11:
      return `<g stroke="${LINE}" stroke-width="0.4"><rect x="59" y="92" width="5" height="4" fill="#7a1f1f"/><rect x="64" y="92" width="5" height="4" fill="#2f3e5c"/><rect x="69" y="92" width="5" height="4" fill="#c99a3b"/><rect x="59" y="96" width="5" height="4" fill="#2d4a33"/><rect x="64" y="96" width="5" height="4" fill="#e0dccf"/></g>`;
    case 12:
      return `<path d="M36 50 L40 50 L42 54 L46 54 M37 54 L39 58 L42 58" stroke="#3fd0e0" stroke-width="0.8" fill="none"/><circle cx="46" cy="54" r="0.9" fill="#3fd0e0"/><circle cx="42" cy="58" r="0.9" fill="#3fd0e0"/>`;
    case 13:
      return `<g stroke="${LINE}" stroke-width="0.8"><rect x="18" y="84" width="18" height="7" rx="2" fill="${STEEL}"/><rect x="22" y="91" width="4" height="14" fill="${STEEL}"/><rect x="21" y="99" width="6" height="3" fill="${BRASS_DARK}"/></g><g stroke="${LINE}" stroke-width="0.5">${cog(32, 87, 3, BRASS)}</g>`;
    case 14:
      return `<g transform="rotate(-14 50 31)"><rect x="37" y="28" width="26" height="5" rx="1" fill="#efeae0" stroke="${LINE}" stroke-width="0.6"/><path d="M57 29 L57 32 M55.5 30.5 L58.5 30.5" stroke="#b83b3b" stroke-width="0.9"/></g>`;
    case 1:
      return `<g fill="${BRASS}" stroke="${LINE}" stroke-width="0.8"><rect x="18" y="84" width="16" height="5" rx="2"/><rect x="66" y="84" width="16" height="5" rx="2"/></g><g stroke="${BRASS}" stroke-width="1">${[20, 24, 28, 32, 68, 72, 76, 80].map((x) => `<path d="M${x} 89 L${x} 93"/>`).join("")}</g>`;
    case 2:
      return `<g stroke="${LINE}" stroke-width="0.6"><path d="M33 92 L33 99" stroke="#7a1f1f" stroke-width="3"/>${cog(33, 103, 4, BRASS)}</g>`;
    case 3:
      return `<g fill="none" stroke="#3a3a3a" stroke-width="1.6"><path d="M31 46 Q30 22 50 22 Q70 22 69 46"/><path d="M68 50 Q66 58 56 59"/></g><rect x="66" y="42" width="5" height="9" rx="1.5" fill="#3a3a3a"/>`;
    case 4:
      return `<g stroke="${LINE}" stroke-width="0.8"><path d="M55 58 L66 62" stroke="#5a3a22" stroke-width="2"/><rect x="64" y="58" width="6" height="7" rx="1.5" fill="#5a3a22"/></g>`;
    case 5:
      return `<path d="M60 36 L64 52 M58 41 L63 40 M59 46 L64 45" stroke="#9c3b3b" stroke-width="1.2" fill="none"/>`;
    case 6:
      return `<g stroke="${LINE}" stroke-width="0.6">${cog(74, 90, 7, BRASS)}${cog(66, 98, 4, BRASS_DARK)}</g>`;
    case 7:
      return `<path d="M42 104 Q50 112 58 106" stroke="${BRASS}" stroke-width="1" fill="none"/><circle cx="58" cy="106" r="2.5" fill="${BRASS}" stroke="${LINE}" stroke-width="0.6"/>`;
    case 8:
      return `<g stroke="${LINE}" stroke-width="0.5">${cog(32, 55, 2.8, BRASS)}</g>`;
    default:
      return "";
  }
}

/** A small cog: a disc with teeth. */
function cog(cx: number, cy: number, r: number, fill: string): string {
  const teeth = Array.from({ length: 8 }, (_, k) => {
    const a = (k / 8) * Math.PI * 2;
    return `<rect x="${(cx + Math.cos(a) * r - r * 0.25).toFixed(2)}" y="${(cy + Math.sin(a) * r - r * 0.25).toFixed(2)}" width="${(r * 0.5).toFixed(2)}" height="${(r * 0.5).toFixed(2)}" fill="${fill}"/>`;
  }).join("");
  return `${teeth}<circle cx="${cx}" cy="${cy}" r="${r * 0.85}" fill="${fill}"/><circle cx="${cx}" cy="${cy}" r="${r * 0.3}" fill="${LINE}"/>`;
}

/** Rank chevrons for experience level 1–5 (stacked, pointing up) in the 100 × 120 frame, bottom-left at (x, bottom). */
function chevrons(level: number, x = 6, bottom = 116): string {
  const n = Math.max(1, Math.min(5, Math.round(level)));
  const h = 4.6;
  const top = bottom - n * h - 4;
  let out = `<rect x="${x}" y="${top.toFixed(1)}" width="18" height="${(bottom - top).toFixed(1)}" rx="2" fill="#141a20" fill-opacity="0.85" stroke="${BRASS_DARK}" stroke-width="0.8"/>`;
  for (let k = 0; k < n; k++) {
    const y = (bottom - 2.5 - k * h).toFixed(1);
    const yt = (bottom - 2.5 - k * h - 3.4).toFixed(1);
    out += `<path d="M${x + 3} ${y} L${x + 9} ${yt} L${x + 15} ${y}" fill="none" stroke="${BRASS}" stroke-width="2.2"/>`;
  }
  return out;
}

/** Level chevrons alone, as a small inline SVG for cards and lists. */
export function chevronsSvg(level: number, height = 18): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 85 20 32" width="${(height * 0.625).toFixed(1)}" height="${height}" class="chevrons" role="img" aria-label="Level ${level}"><title>Level ${level}</title>${chevrons(level)}</svg>`;
}

/**
 * The portrait as SVG markup (viewBox 100 × 120), `size` px wide. With `level`, rank chevrons for the
 * officer's experience sit at the lower left.
 */
export function portraitSvg(spec: PortraitSpec, size = 96, level?: number): string {
  const skin = at(SKIN, spec.skin);
  const hairC = at(HAIR, spec.hairColor);
  const cloth = at(CLOTH, spec.uniformColor);
  const suit = spec.suit
    ? `<g><path fill="#c8ccd2" stroke="${LINE}" stroke-width="1.2" d="M10 120 Q12 84 34 78 L66 78 Q88 84 90 120 Z"/><rect x="30" y="74" width="40" height="8" rx="3" fill="${STEEL}" stroke="${LINE}"/><rect x="44" y="96" width="12" height="9" rx="1" fill="${cloth}" stroke="${LINE}"/></g>`
    : "";
  const helmet = spec.suit
    ? `<circle cx="50" cy="44" r="31" fill="#9fd8ff" fill-opacity="0.18" stroke="#dfe7ee" stroke-width="2.5"/><path d="M33 28 Q40 20 50 19" stroke="#ffffff" stroke-opacity="0.7" stroke-width="2" fill="none"/>`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120" width="${size}" height="${(size * 1.2).toFixed(0)}" class="portrait">` +
    `<rect width="100" height="120" rx="6" fill="#26303a"/>` +
    (spec.suit ? suit : body(spec, cloth, skin) + collar(spec.collar, cloth) + neckwear(spec.neck)) +
    head(spec.head, skin) +
    facialHair(spec.facialHair, hairC) +
    mouth(spec.mouth) +
    eyes(spec.eyes) +
    hair(spec.hair, hairC) +
    [...new Set([spec.accessory, ...(spec.extras ?? [])])].map(accessory).join("") +
    helmet +
    (level ? chevrons(level) : "") +
    `</svg>`
  );
}

/** Uniform styles: a uniform, its cap and collar, and a colour (the portrait dialog's style picker). */
export const UNIFORM_STYLE_LABELS: Record<string, string> = {
  colonial: "British colonial navy",
  modern: "Modern, metal stripes",
  kaiser: "Kaisermarine",
};

/** All accessories of a portrait (the primary one and the extras), without "none". */
export const accessoriesOf = (spec: PortraitSpec): number[] =>
  [...new Set([spec.accessory, ...(spec.extras ?? [])])].filter((a) => a > 0);

/** A portrait with exactly these accessories (the first is the primary one). */
export function withAccessories(spec: PortraitSpec, list: readonly number[]): PortraitSpec {
  const uniq = [...new Set(list.filter((a) => a > 0))];
  const { extras: _old, ...rest } = spec;
  return uniq.length > 1
    ? { ...rest, accessory: uniq[0]!, extras: uniq.slice(1) }
    : { ...rest, accessory: uniq[0] ?? 0 };
}

/** Option count of a part (for the portrait dialog's arrows). */
export const partCount = (k: PortraitPart): number => PORTRAIT_COUNTS[k];
