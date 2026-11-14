import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  return errors;
}

/** Missile boat with both magazine types, a reactor and a chemical and an ion engine at the stern. */
const boat = {
  formatVersion: 1,
  id: "e2e-ordnance",
  name: "Ordnance",
  createdAt: "2026-11-13T00:00:00Z",
  modifiedAt: "2026-11-13T00:00:00Z",
  weaponGroupModes: {},
  powerPriority: ["gyro", "propulsion", "pointDefense", "weapons", "hangar"],
  parts: [
    { uid: "cmd", partId: "core:command.s", x: 0, y: 0, angle: 0 },
    { uid: "ml", partId: "core:weapon.missile.launcher.s", x: 1.5, y: 0, angle: 0 },
    { uid: "smart", partId: "core:magazine.missile.s", x: 0, y: 1.25, angle: 0 },
    { uid: "rocket", partId: "core:magazine.rocket.s", x: 0, y: -1.25, angle: 0 },
    { uid: "h1", partId: "core:hull.square.m", x: -1.75, y: 0, angle: 0 },
    { uid: "h2", partId: "core:hull.square.m", x: -3.75, y: 0, angle: 0 },
    { uid: "rx", partId: "core:reactor.s", x: -1.75, y: 1.75, angle: 0 },
    { uid: "tank", partId: "core:tank.fuel.s", x: -1.75, y: -1.5, angle: 0 },
    { uid: "chem", partId: "core:engine.main.s", x: -5.25, y: 0.75, angle: 0 },
    { uid: "ion", partId: "core:engine.ion.s", x: -5.25, y: -0.75, angle: 0 },
  ],
};

test("missile types come from the magazines: pick one in the ordnance panel or with Z, rockets fire without a target", async ({
  page,
}) => {
  const errors = await open(page);
  await page.evaluate(
    (d) => (window as unknown as { __game: { testFlight(d: unknown): void } }).__game.testFlight(d),
    boat,
  );
  await expect(page.getByTestId("speed")).toBeVisible();
  const smart = page.getByTestId("missile-type-missile-smart");
  const rocket = page.getByTestId("missile-type-missile-rocket");
  await expect(smart).toContainText("Smart missile ×14");
  await expect(rocket).toContainText("Rocket ×29");
  await expect(smart).toHaveAttribute("aria-pressed", "true");
  // A smart missile needs a target: M does nothing yet.
  await page.locator("#view").click({ position: { x: 640, y: 200 }, button: "middle" });
  await page.keyboard.press("m");
  await expect(page.getByTestId("missiles-out")).toHaveText("0");
  // Z switches to rockets; they fire where the launcher points.
  await page.keyboard.press("z");
  await expect(rocket).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("m");
  await expect(page.getByTestId("missiles-out")).toHaveText("1");
  await expect(rocket).toContainText("Rocket ×28");
  await expect(smart).toContainText("Smart missile ×14");
  // Clicking picks a type too.
  await smart.click();
  await expect(smart).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});

test("ion engines: the drive chip shows the mode and I cycles all, ion, chemical", async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(
    (d) => (window as unknown as { __game: { testFlight(d: unknown): void } }).__game.testFlight(d),
    boat,
  );
  const chip = page.getByTestId("drive-mode");
  await expect(chip).toContainText("all");
  await page.locator("#view").click({ position: { x: 640, y: 200 }, button: "middle" });
  await page.keyboard.press("i");
  await expect(chip).toContainText("ion");
  // Ion only: the ship still accelerates, slowly, and the engine draws power.
  await page.keyboard.down("w");
  await expect
    .poll(async () => Number(await page.getByTestId("speed").textContent()), { timeout: 15_000 })
    .toBeGreaterThan(2);
  await expect(page.getByTestId("power-factor-propulsion")).toBeVisible();
  await page.keyboard.up("w");
  await page.keyboard.press("i");
  await expect(chip).toContainText("chemical");
  await page.keyboard.press("i");
  await expect(chip).toContainText("all");
  expect(errors).toEqual([]);
});

test("drone types: the sandbox frigate picks which hangar H launches", async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => (window as unknown as { __game: { openSandbox(): void } }).__game.openSandbox());
  await expect(page.getByTestId("speed")).toBeVisible();
  await page.locator("#view").click({ position: { x: 640, y: 200 }, button: "middle" });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("ship-name")).toContainText("Harrier");
  await expect(page.getByTestId("drone-type-any")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("drone-type-drone-decoy").click();
  await expect(page.getByTestId("drone-type-drone-decoy")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("drone-type-drone-decoy")).toContainText("decoy ×4");
  await page.keyboard.press("h");
  await expect(page.getByTestId("drone-type-drone-decoy")).toContainText("decoy ×3");
  await expect(page.getByTestId("drone-type-drone-attack")).toContainText("attack ×4");
  // U goes on to the next type, then back to any.
  await page.keyboard.press("u");
  await expect(page.getByTestId("drone-type-any")).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});

test("editor: both missile magazines and the ion engines are in the palette", async ({ page }) => {
  await open(page);
  await page.getByTestId("palette-search").fill("rocket");
  await expect(page.getByTestId("palette")).toContainText("Rocket magazine S");
  await page.getByTestId("palette-search").fill("smart");
  await expect(page.getByTestId("palette")).toContainText("Smart missile magazine S");
  await page.getByTestId("palette-search").fill("ion");
  await expect(page.getByTestId("palette")).toContainText("Ion engine S");
  await expect(page.getByTestId("palette")).toContainText("Ion engine L");
});
