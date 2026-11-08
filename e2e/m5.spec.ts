import { expect, test, type Page } from "@playwright/test";

interface Game {
  openSandbox(): void;
  setTarget(id: string | null): void;
  enemies(): string[];
  world: { combat: { missiles: unknown[]; stats: { missilesLaunched: number } } } | null;
}
const game = <T>(page: Page, fn: (g: Game) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__game)`) as Promise<T>;

test("M5: Harrier launches missiles at its target (M), drones (H), and toggles PD vs ships (O)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  await game(page, (g) => g.openSandbox());
  await expect(page.getByTestId("speed")).toBeVisible();
  await page.locator("#view").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator("#hud")).toContainText("Harrier");
  await expect(page.locator("#hud")).toContainText("right-click a target first");

  // Target the Sentinel picket (the last enemy) and launch.
  await game(page, (g) => g.setTarget(g.enemies().at(-1)!));
  await expect(page.getByTestId("target")).toContainText("Sentinel");
  await page.keyboard.press("m");
  await expect.poll(() => game(page, (g) => g.world!.combat.stats.missilesLaunched)).toBe(2);
  await expect(page.getByTestId("missiles-out")).not.toHaveText("0");

  // Drones: 4 attack drones and 4 decoys queue up.
  await expect(page.getByTestId("drones-stored")).toHaveText("8");
  await page.keyboard.press("h");
  await expect
    .poll(async () => Number(await page.getByTestId("drones-out").textContent()), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(3);

  await expect(page.getByTestId("pd-ships")).toHaveText("off");
  await page.keyboard.press("o");
  await expect(page.getByTestId("pd-ships")).toHaveText("on");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "test-results/m5-sandbox.png" });
  expect(errors).toEqual([]);
});
