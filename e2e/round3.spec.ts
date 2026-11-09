import { expect, test, type Page } from "@playwright/test";

interface Pt {
  x: number;
  y: number;
}
const editor = <T>(page: Page, src: string): Promise<T> =>
  page.evaluate(`(() => { const e = window.__editor; ${src} })()`) as Promise<T>;

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  return errors;
}

/** Picks a part from the palette and clicks it onto the canvas at a point the editor computes. */
async function place(page: Page, partId: string, where: string) {
  await page.getByTestId("palette-search").fill(partId);
  await page.getByTestId(`palette-${partId}`).click();
  await page.getByTestId("palette-search").fill("");
  await page.getByTestId("palette-search").blur();
  const box = (await page.locator("#view").boundingBox())!;
  const pt = await editor<Pt>(page, `return ${where};`);
  await page.mouse.move(box.x + pt.x, box.y + pt.y, { steps: 3 });
  await page.mouse.click(box.x + pt.x, box.y + pt.y);
}

test("editor: dragging a part carries what hangs on it", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await open(page);
  await page.getByTestId("btn-new").click();
  await place(page, "core:command.s", "e.toScreen({ x: 0, y: 0 })"); // p1
  await place(page, "core:tank.fuel.s", 'e.attachPoint("p1", 3, 0.5)'); // p2 behind the command module
  await place(page, "core:engine.main.s", 'e.attachPoint("p2", 3, 0.5)'); // p3 behind the tank
  await page.keyboard.press("Escape");
  const pos = (uid: string) =>
    editor<Pt>(
      page,
      `const p = e.model.design.parts.find((q) => q.uid === "${uid}"); return { x: p.x, y: p.y };`,
    );
  const tank0 = await pos("p2");
  const eng0 = await pos("p3");

  // Drag the tank 3 m down: the engine hanging on it comes along.
  const box = (await page.locator("#view").boundingBox())!;
  const from = await editor<Pt>(page, `return e.toScreen({ x: ${tank0.x}, y: ${tank0.y} });`);
  const to = await editor<Pt>(page, `return e.toScreen({ x: ${tank0.x}, y: ${tank0.y - 3} });`);
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + (from.x + to.x) / 2, box.y + (from.y + to.y) / 2, { steps: 4 });
  await page.keyboard.down("Alt"); // no snapping, so the move is exact
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 4 });
  await expect(page.locator(".ed-status")).toContainText("carrying 1 attached part");
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const tank1 = await pos("p2");
  const eng1 = await pos("p3");
  expect(tank1.y).toBeLessThan(tank0.y - 2);
  expect(eng1.x - tank1.x).toBeCloseTo(eng0.x - tank0.x, 1);
  expect(eng1.y - tank1.y).toBeCloseTo(eng0.y - tank0.y, 1);
  expect(errors).toEqual([]);
});

test("flight: the weapon-group bar shows every group, its mode and the selection", async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => (window as unknown as { __game: { openSandbox(): void } }).__game.openSandbox());
  await expect(page.getByTestId("speed")).toBeVisible();
  await page.locator("#view").click({ position: { x: 5, y: 5 } });
  const bar = page.getByTestId("weapon-bar");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("wb-group-1")).toContainText("Kinetic cannon");
  await expect(page.getByTestId("wb-group-2")).toContainText("Autocannon turret");
  await expect(page.getByTestId("wb-group-1")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("wb-group-2")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("2");
  await expect(page.getByTestId("wb-group-2")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("wb-group-1")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("g");
  await expect(page.getByTestId("wb-mode-2")).toHaveText("HOLD");
  await page.getByTestId("wb-group-1").click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("wb-group-1")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("wb-group-2")).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "test-results/weapon-bar.png" });
  expect(errors).toEqual([]);
});
