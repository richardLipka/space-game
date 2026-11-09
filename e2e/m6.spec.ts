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

test("Skirmish: set up sides and AI types, start, the enemy AI engages", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await open(page);
  await page.getByTestId("btn-skirmish").click();
  await expect(page.getByTestId("skirmish-dialog")).toBeVisible();
  // Default setup: you in a Rapier with a Wasp guarding you, against an aggressive Rapier and a cautious Viper.
  await expect(page.getByTestId("skirmish-pilot-0-0")).toHaveValue("player");
  await expect(page.getByTestId("skirmish-pilot-1-1")).toHaveValue("cautious");
  await expect(page.getByTestId("skirmish-param-1-0-rangeFactor")).toBeVisible();
  // Add a retreating Wasp to side 2.
  await page.getByTestId("skirmish-add-1").click();
  await page.getByTestId("skirmish-design-1-2").selectOption("fleet-wasp");
  await page.getByTestId("skirmish-pilot-1-2").selectOption("retreating");
  await expect(page.getByTestId("skirmish-param-1-2-withdrawSpeed")).toBeVisible();
  await page.getByTestId("skirmish-start").click();
  await expect(page.getByTestId("speed")).toBeVisible();
  const enemies = await game<string[]>(page, "window.__game.enemies()");
  expect(enemies).toHaveLength(3);
  const ally = (await game<string[]>(page, "window.__game.playerShips()")).length;
  expect(ally).toBe(1);
  await expect
    .poll(
      async () =>
        (await game<{ behaviour: string }>(page, `window.__game.ai(${JSON.stringify(enemies[0])})`))
          .behaviour,
      { timeout: 15_000 },
    )
    .not.toBe("idle");
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "test-results/skirmish.png" });
  expect(errors).toEqual([]);
});

test("Skirmish without a player ship is watched until one side is down", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await open(page);
  await page.getByTestId("btn-skirmish").click();
  await page.getByTestId("skirmish-reset").click();
  await page.getByTestId("skirmish-pilot-0-0").selectOption("aggressive");
  await expect(page.getByTestId("skirmish-start")).toHaveText("Watch battle");
  await page.getByTestId("skirmish-start").click();
  await expect(page.locator("#hud")).toContainText("Watching");
  await page.waitForTimeout(2000);
  expect(await game<{ status: string }>(page, "window.__game.battle()")).toMatchObject({ status: "running" });
  expect(errors).toEqual([]);
});

test("group keys use the key position: a Czech layout's '+' on the 1 key selects group 1, not faster time", async ({
  page,
}) => {
  const errors = await open(page);
  await game(page, "window.__game.openSandbox()");
  await expect(page.getByTestId("speed")).toBeVisible();
  const press = (key: string, code: string) =>
    page.evaluate(
      ([k, c]) => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: c }));
        window.dispatchEvent(new KeyboardEvent("keyup", { key: k, code: c }));
      },
      [key, code],
    );
  await press("ě", "Digit2");
  await expect(page.getByTestId("wb-group-2")).toHaveAttribute("aria-pressed", "true");
  await press("+", "Digit1");
  await expect(page.getByTestId("wb-group-1")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#hud")).toContainText("×1 ");
  expect(errors).toEqual([]);
});
