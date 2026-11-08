import { expect, test, type Page } from "@playwright/test";

const game = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  return errors;
}

test("M6: allies follow under AI; Tab hands the previous ship to the AI; J/K/L give orders", async ({
  page,
}) => {
  const errors = await open(page);
  await game(page, "window.__game.openSandbox()");
  await expect(page.getByTestId("speed")).toBeVisible();
  await page.locator("#view").click({ position: { x: 5, y: 5 } });
  const ids = await game<string[]>(page, "window.__game.playerShips()");
  await expect(page.getByTestId("allies")).toContainText("follow");
  expect(await game(page, `window.__game.ai(${JSON.stringify(ids[0])})`)).toBeNull();
  await expect
    .poll(() => game<{ order: string }>(page, `window.__game.ai(${JSON.stringify(ids[1])})`))
    .toMatchObject({ order: "follow" });

  await page.keyboard.press("Tab");
  await expect(page.locator("#hud")).toContainText("Kestrel");
  expect(await game(page, `window.__game.ai(${JSON.stringify(ids[1])})`)).toBeNull();
  await expect
    .poll(() => game<{ order: string }>(page, `window.__game.ai(${JSON.stringify(ids[0])})`))
    .toMatchObject({ order: "follow" });

  // Hold, then attack the selected target, works while paused too.
  await game(page, "window.__game.pause(true)");
  await page.keyboard.press("l");
  await expect
    .poll(() => game<{ order: string }>(page, `window.__game.ai(${JSON.stringify(ids[0])})`))
    .toMatchObject({ order: "hold" });
  await game(page, "window.__game.setTarget(window.__game.enemies()[0])");
  await page.keyboard.press("k");
  await expect
    .poll(() => game<{ order: string }>(page, `window.__game.ai(${JSON.stringify(ids[0])})`))
    .toMatchObject({ order: "attack" });
  await game(page, "window.__game.pause(false)");
  await expect(page.getByTestId("allies")).toContainText("attack");
  expect(errors).toEqual([]);
});

test("M6: Skirmish starts an AI squadron that closes in and engages", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await open(page);
  await page.getByTestId("btn-skirmish").click();
  await expect(page.getByTestId("speed")).toBeVisible();
  const enemies = await game<string[]>(page, "window.__game.enemies()");
  expect(enemies).toHaveLength(3);
  await expect
    .poll(
      async () =>
        (await game<{ behaviour: string }>(page, `window.__game.ai(${JSON.stringify(enemies[0])})`))
          .behaviour,
      { timeout: 15_000 },
    )
    .not.toBe("idle");
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "test-results/m6-skirmish.png" });
  expect(errors).toEqual([]);
});
