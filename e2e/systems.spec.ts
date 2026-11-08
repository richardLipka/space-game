import { expect, test, type Page } from "@playwright/test";

const NOW = "2026-11-08T00:00:00Z";
/**
 * Power-starved test ship from core parts: the command module's 30 kW auxiliary generator must feed
 * the command gyro (5 kW) + a gyroscope (40 kW) and, when firing, a 900 kW laser lance.
 */
const starved = {
  formatVersion: 1,
  id: "e2e-starved",
  name: "Starved",
  createdAt: NOW,
  modifiedAt: NOW,
  weaponGroupModes: {},
  powerPriority: ["gyro", "propulsion", "pointDefense", "weapons", "hangar"],
  parts: [
    { uid: "cmd", partId: "core:command.s", x: 0, y: 0, angle: 0 },
    { uid: "beam", partId: "core:hull.square.s", x: -1.25, y: 0, angle: 0 },
    { uid: "gyro", partId: "core:gyro.s", x: -2.25, y: 0, angle: 0 },
    { uid: "lance", partId: "core:weapon.lance.fixed.m", x: 2.25, y: 0, angle: 0 },
  ],
};

async function fly(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.evaluate(
    (d) => (window as unknown as { __game: { testFlight(d: unknown): void } }).__game.testFlight(d),
    starved,
  );
  await expect(page.getByTestId("speed")).toBeVisible();
  return errors;
}

const activate = (page: Page, on: boolean) =>
  page.evaluate(
    (v) =>
      (window as unknown as { __game: { activateWeapons(on: boolean): void } }).__game.activateWeapons(v),
    on,
  );

test("3.21 changing power priority in the HUD changes which group browns out", async ({ page }) => {
  const errors = await fly(page);
  await activate(page, true);
  // Default order: gyro before weapons → gyro gets 30/45 kW, the lance nothing.
  await expect(page.getByTestId("power-factor-gyro")).toHaveText("gyro 67%");
  await expect(page.getByTestId("power-factor-weapons")).toHaveText("weapons 0%");

  await page.keyboard.press("p");
  const panel = page.getByTestId("power-panel");
  await expect(panel).toBeVisible();
  for (let i = 0; i < 3; i++) await panel.getByTestId("power-up-weapons").click();
  await expect(panel).toContainText("1. weapons");
  // Weapons first → the lance takes the whole 30 kW (3 %), gyros are browned out.
  await expect(page.getByTestId("power-factor-weapons")).toHaveText("weapons 3%");
  await expect(page.getByTestId("power-factor-gyro")).toHaveText("gyro 0%");

  await activate(page, false);
  await expect(page.getByTestId("power-factor-gyro")).toHaveText("gyro 67%");
  expect(errors).toEqual([]);
});

test("destroying a connecting part cuts off a section; the HUD shows where heat goes", async ({ page }) => {
  await fly(page);
  await expect(page.getByTestId("cut-off")).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { __game: { killPart(uid: string): void } }).__game.killPart("beam"),
  );
  await expect(page.getByTestId("cut-off")).toContainText("1 part(s) cut off from command");
  // The cut-off gyroscope no longer draws power: only the command gyro's 5 kW remains.
  await expect(page.getByTestId("power-used")).toHaveText("5 kW");
  // No radiators on this ship: the hull alone sheds heat.
  await expect(page.locator("#hud")).toContainText("no radiators");
  await expect(page.getByTestId("heat-shed")).toHaveText(/−\d+ kW/);
  await expect(page.locator("#hud")).toContainText("hull");
});
