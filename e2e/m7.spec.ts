import { expect, test } from "@playwright/test";

test("7.9 full loop: pick a scenario → build the fleet → fight → results → back to the editor", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();

  // Pick the first scenario.
  await page.getByTestId("btn-scenarios").click();
  await expect(page.getByTestId("scenario-dialog")).toBeVisible();
  await expect(page.getByTestId("scenario-list")).toContainText("First flight");
  await page.getByTestId("scenario-s01-first-flight").click();
  const panel = page.getByTestId("scenario-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("scenario-objective")).toHaveText("Destroy every enemy ship");

  // Build: an empty fleet cannot start; the suggested fleet fits the budget.
  await expect(page.getByTestId("btn-start-battle")).toBeDisabled();
  await page.getByTestId("btn-fleet-suggested").click();
  await expect(page.getByTestId("fleet-cost")).toHaveText("212 / 250");
  await expect(page.getByTestId("btn-start-battle")).toBeEnabled();

  // Fight (scripted): the objective shows in the HUD, then every enemy goes down.
  await page.getByTestId("btn-start-battle").click();
  await expect(page.getByTestId("objective")).toContainText("destroy all enemies");
  await page.evaluate(() => (window as unknown as { __game: { killEnemies(): void } }).__game.killEnemies());

  // Results.
  await expect(page.getByTestId("results")).toBeVisible();
  await expect(page.getByTestId("result-status")).toHaveText("Victory");
  await expect(page.getByTestId("result-scenario")).toHaveText("First flight");
  await page.screenshot({ path: "test-results/m7-results.png" });

  // Back to the editor: the scenario stays selected, and the list remembers the win.
  await page.getByTestId("btn-results-editor").click();
  await expect(page.getByTestId("palette")).toBeVisible();
  await expect(page.getByTestId("results")).toBeHidden();
  await expect(panel).toBeVisible();
  await page.getByTestId("btn-scenarios").click();
  await expect(page.getByTestId("scenario-list")).toContainText("✓ won in");
  expect(errors).toEqual([]);
});

test("7.4 an over-budget fleet cannot start", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.getByTestId("btn-scenarios").click();
  await page.getByTestId("scenario-s01-first-flight").click();
  for (let i = 0; i < 3; i++) await page.getByTestId("btn-fleet-add").click(); // 3 × Kestrel: too many ships and over budget
  await expect(page.getByTestId("fleet-error").first()).toBeVisible();
  await expect(page.getByTestId("btn-start-battle")).toBeDisabled();
});
