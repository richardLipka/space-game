import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  return errors;
}

const speed = async (page: Page) => Number(await page.getByTestId("speed").textContent());

test("flight model: newtonian by default; arcade picked in the toolbar holds a top speed and stops by itself", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = await open(page);
  await expect(page.getByTestId("flight-model")).toHaveValue("newtonian");
  await page.getByTestId("btn-test-flight").click();
  await expect(page.getByTestId("flight-model-tag")).toHaveText("NEWTONIAN");
  await expect(page.getByTestId("speedkill")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toBeVisible();

  await page.getByTestId("flight-model").selectOption("arcade");
  await page.getByTestId("btn-test-flight").click();
  await expect(page.getByTestId("flight-model-tag")).toHaveText("ARCADE");
  const top = Number((await page.getByTestId("top-speed").textContent())!.replace(/\D+/g, ""));
  expect(top).toBeGreaterThan(40);
  await page.locator("#view").click({ position: { x: 640, y: 300 }, button: "middle" });

  // Hold forward: up to the top speed, never past it.
  await page.keyboard.down("w");
  await expect.poll(() => speed(page), { timeout: 30_000 }).toBeGreaterThan(top * 0.95);
  await page.waitForTimeout(1000);
  expect(await speed(page)).toBeLessThan(top * 1.03);
  // Release: the ship comes to a stop without any braking burn.
  await page.keyboard.up("w");
  await expect.poll(() => speed(page), { timeout: 20_000 }).toBeLessThan(1);

  // The choice is remembered for the next flight.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("flight-model")).toHaveValue("arcade");
  expect(errors).toEqual([]);
});

test("skirmish: the flight model is part of the setup", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await open(page);
  await page.getByTestId("btn-skirmish").click();
  await expect(page.getByTestId("skirmish-flight-model")).toHaveValue("newtonian");
  await page.getByTestId("skirmish-flight-model").selectOption("arcade");
  await expect(page.getByTestId("skirmish-flight-help")).toContainText("top speed");
  await page.getByTestId("skirmish-start").click();
  await expect(page.getByTestId("flight-model-tag")).toHaveText("ARCADE");
  await expect(page.getByTestId("top-speed")).toBeVisible();
  // The enemy AI flies and engages under the arcade model too.
  const enemy = (await page.evaluate("window.__game.enemies()")) as string[];
  await expect
    .poll(
      async () =>
        ((await page.evaluate(`window.__game.ai(${JSON.stringify(enemy[0])})`)) as { behaviour: string })
          .behaviour,
      { timeout: 15_000 },
    )
    .not.toBe("idle");
  expect(errors).toEqual([]);
});
