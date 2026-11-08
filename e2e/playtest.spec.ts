import { expect, test, type Page } from "@playwright/test";

/** Playtest round 1 feedback: palette search/accordion, part info, HUD ammo/heat, ejection. */

interface Game {
  openSandbox(): void;
  pause(p: boolean): void;
  screenOfPart(uid: string): { x: number; y: number } | null;
  partUids(): string[];
  debrisCount(): number;
}
const game = <T>(page: Page, fn: (g: Game) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__game)`) as Promise<T>;

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  return errors;
}

test("palette: categories open and close, search filters, part info shows turret turn rate", async ({
  page,
}) => {
  const errors = await open(page);
  const weapons = page.getByTestId("palette-cat-weapon");
  const heavy = page.getByTestId("palette-core:weapon.cannon.turret.m");
  // Weapons start collapsed; clicking the heading opens the category.
  await expect(heavy).toBeHidden();
  await weapons.locator("summary").click();
  await expect(heavy).toBeVisible();
  await weapons.locator("summary").click();
  await expect(heavy).toBeHidden();

  // Search shows matches only, with their categories open.
  const search = page.getByTestId("palette-search");
  await search.fill("turret");
  await expect(heavy).toBeVisible();
  await expect(page.getByTestId("palette-core:weapon.cannon.fixed.m")).toHaveCount(0);
  await expect(page.getByTestId("palette-core:hull.square.s")).toHaveCount(0);
  await heavy.hover();
  await expect(page.getByTestId("part-info")).toContainText("Heavy cannon turret");
  await expect(page.getByTestId("part-info")).toContainText("45°/s");
  await page.getByTestId("palette-core:weapon.autocannon.turret.light").hover();
  await expect(page.getByTestId("part-info")).toContainText("240°/s");

  // Typing in the search box must not trigger editor shortcuts; Esc clears it.
  await search.fill("zzz");
  await expect(page.getByTestId("palette")).toContainText('No parts match "zzz"');
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.getByTestId("palette-core:hull.square.s")).toBeVisible();
  expect(errors).toEqual([]);
});

test("flight HUD lists ammunition and where heat comes from and goes", async ({ page }) => {
  const errors = await open(page);
  await game(page, (g) => g.openSandbox());
  await expect(page.getByTestId("ammo-autocannon-30")).toHaveText("600");
  await expect(page.getByTestId("ammo-kinetic-120")).toHaveText("40");
  await expect(page.getByTestId("group-2")).toContainText("loaded 60/60");
  await page.keyboard.down("w");
  await expect(page.locator("#hud")).toContainText("engines");
  await page.keyboard.up("w");
  await expect(page.getByTestId("heat-made")).toBeVisible();
  await expect(page.locator("#hud")).toContainText("hull");
  expect(errors).toEqual([]);
});

test("B enters eject mode; clicking a part jettisons it as debris", async ({ page }) => {
  const errors = await open(page);
  await game(page, (g) => g.openSandbox());
  await expect(page.getByTestId("speed")).toBeVisible();
  await page.locator("#view").click({ position: { x: 5, y: 5 } });
  await game(page, (g) => g.pause(true));
  await page.keyboard.press("b");
  await expect(page.getByTestId("eject-mode")).toBeVisible();
  expect(await game(page, (g) => g.partUids())).toContain("mag-k");
  const box = (await page.locator("#view").boundingBox())!;
  /** Points at a part, re-aiming while the camera settles, until the HUD confirms the hover. */
  const hover = async (uid: string, expectText: string, testId?: string) => {
    await expect
      .poll(
        async () => {
          const pt = (await page.evaluate(`window.__game.screenOfPart(${JSON.stringify(uid)})`)) as {
            x: number;
            y: number;
          };
          await page.mouse.move(box.x + pt.x, box.y + pt.y);
          const loc = testId ? page.getByTestId(testId) : page.locator("#hud");
          return ((await loc.count()) ? await loc.first().innerText() : "").includes(expectText);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  };
  await hover("mag-k", "click to eject Kinetic magazine S");
  const pt = (await game(page, (g) => g.screenOfPart("mag-k")))!;
  await page.mouse.click(box.x + pt.x, box.y + pt.y);
  await game(page, (g) => g.pause(false));
  await expect.poll(() => game(page, (g) => g.debrisCount())).toBe(1);
  expect(await game(page, (g) => g.partUids())).not.toContain("mag-k");
  // The command module cannot be ejected.
  await hover("cmd", "cannot eject the command module");
  // The fuel tank carries the main engine behind it: the HUD warns that it leaves too.
  await hover("tank", "attached part", "eject-extra");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("eject-mode")).toHaveCount(0);
  await expect(page.getByTestId("palette")).toBeHidden(); // Esc left eject mode, not the flight
  await page.screenshot({ path: "test-results/playtest-eject.png" });
  expect(errors).toEqual([]);
});

test("G shows the connection graph with resource lanes and a legend", async ({ page }) => {
  const errors = await open(page);
  const panel = page.getByTestId("graph-panel");
  await expect(panel).toBeHidden();
  await page.locator("#view").click({ position: { x: 600, y: 600 } });
  await page.keyboard.press("g");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("power");
  await expect(panel).toContainText("fuel");
  await expect(panel).toContainText("ammunition");
  await expect(page.getByTestId("graph-ok")).toBeVisible(); // the demo fighter is fully supplied
  await expect(page.getByTestId("overlay-graph")).toBeChecked();
  await page.screenshot({ path: "test-results/editor-graph.png" });
  await page.keyboard.press("g");
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});

test("part info never covers the palette: the last part of a long list stays clickable", async ({ page }) => {
  const errors = await open(page);
  await page.waitForTimeout(800); // the demo design loads and rebuilds the palette
  for (const c of ["armor", "propulsion", "power", "thermal", "storage", "weapon"])
    await page.getByTestId(`palette-cat-${c}`).locator("summary").click();
  const list = page.locator(".ed-part-list");
  await list.evaluate((e) => (e.scrollTop = e.scrollHeight));
  const last = page.locator(".ed-part:visible").last();
  const id = await last.getAttribute("data-testid");
  const before = (await last.boundingBox())!;
  await last.hover();
  await expect(page.getByTestId("part-info")).toBeVisible();
  // Hovering does not move the row, and the card is beside the palette, not on top of it.
  expect(await last.boundingBox()).toEqual(before);
  const card = (await page.getByTestId("part-info").boundingBox())!;
  const palette = (await page.getByTestId("palette").boundingBox())!;
  expect(card.x).toBeGreaterThanOrEqual(palette.x + palette.width);
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest(".ed-part")?.getAttribute("data-testid"),
    { x: before.x + 30, y: before.y + before.height / 2 },
  );
  expect(hit).toBe(id);
  await last.click(); // starts placing that part
  await expect(page.locator(".ed-status")).toBeVisible();
  await page.mouse.move(700, 400);
  await expect(page.getByTestId("part-info")).toBeHidden();
  expect(errors).toEqual([]);
});
