import { expect, test, type Page } from "@playwright/test";

interface GameHandle {
  hash(): string;
  pause(p: boolean): void;
  setTheme(name: string): Promise<void>;
  resolveStyle(classes: string): { stroke: string };
  controlled: string;
}

/** Runs `fn` in the page against the debug handle `window.__game`. */
const game = <T>(page: Page, fn: (g: GameHandle) => T | Promise<T>): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__game)`) as Promise<T>;

async function ready(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("btn-sandbox")).toBeVisible();
  await page.getByTestId("btn-sandbox").click();
  await expect(page.getByTestId("tick")).toBeVisible();
  await page.locator("#view").click({ position: { x: 5, y: 5 } });
  return errors;
}

test("1.30 ship responds to W: speed increases", async ({ page }) => {
  const errors = await ready(page);
  const speed = page.getByTestId("speed");
  expect(Number(await speed.textContent())).toBe(0);
  await page.keyboard.down("w");
  await expect.poll(async () => Number(await speed.textContent()), { timeout: 5000 }).toBeGreaterThan(10);
  await page.keyboard.up("w");
  expect(errors).toEqual([]);
});

test("speed kill (X) brings the fighter back to rest (turning to burn if that is faster)", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await ready(page);
  await page.keyboard.press("Tab"); // the fighter has rear-facing RCS (the gunboat does not)
  await expect(page.locator("#hud")).toContainText("Kestrel");
  const speed = page.getByTestId("speed");
  await page.keyboard.down("w");
  await expect.poll(async () => Number(await speed.textContent())).toBeGreaterThan(20);
  await page.keyboard.up("w");
  await page.keyboard.press("x");
  await expect(page.getByTestId("speedkill")).toHaveText(/keep|flip/);
  await expect.poll(async () => Number(await speed.textContent()), { timeout: 15_000 }).toBeLessThan(0.1);
  await expect(page.getByTestId("speedkill")).toHaveText("off");
});

test("speed kill (X) stops the gunboat, which has no retro thrust, by flipping", async ({ page }) => {
  test.setTimeout(45_000);
  await ready(page);
  await expect(page.locator("#hud")).toContainText("Lancer");
  const speed = page.getByTestId("speed");
  await page.keyboard.down("w");
  await expect.poll(async () => Number(await speed.textContent())).toBeGreaterThan(20);
  await page.keyboard.up("w");
  await page.keyboard.press("x");
  await expect(page.getByTestId("speedkill")).toHaveText("flip");
  await expect.poll(async () => Number(await speed.textContent()), { timeout: 20_000 }).toBeLessThan(0.1);
});

test("flip and burn (Shift+X) stops a ship without retro thrust", async ({ page }) => {
  test.setTimeout(45_000);
  await ready(page);
  await expect(page.locator("#hud")).toContainText("Lancer");
  const speed = page.getByTestId("speed");
  await page.keyboard.down("w");
  await expect.poll(async () => Number(await speed.textContent())).toBeGreaterThan(20);
  await page.keyboard.up("w");
  await page.keyboard.press("Shift+X");
  await expect(page.getByTestId("speedkill")).toHaveText("flip");
  await expect.poll(async () => Number(await speed.textContent()), { timeout: 20_000 }).toBeLessThan(0.1);
  await expect(page.getByTestId("speedkill")).toHaveText("off");
});

test("1.28 / 1.30 theme switch changes pixels and resolved styles, not the simulation", async ({ page }) => {
  await ready(page);
  await game(page, (g) => g.pause(true));
  await page.waitForTimeout(300);
  const hashBefore = await game(page, (g) => g.hash());
  const strokeBefore = await game(page, (g) => g.resolveStyle("part cat-command team-0 state-ok").stroke);
  const shotBefore = await page.locator("#view").screenshot();
  await page.screenshot({ path: "test-results/m1-neon.png" });

  await game(page, (g) => g.setTheme("flat"));
  await page.waitForTimeout(300);
  const shotAfter = await page.locator("#view").screenshot();
  await page.screenshot({ path: "test-results/m1-flat.png" });

  expect(await game(page, (g) => g.resolveStyle("part cat-command team-0 state-ok").stroke)).not.toBe(
    strokeBefore,
  );
  expect(shotAfter.equals(shotBefore)).toBe(false);
  expect(await game(page, (g) => g.hash())).toBe(hashBefore);
});
