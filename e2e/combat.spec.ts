import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

interface CatPart {
  id: string;
  magazine?: { capacity: number };
  weapon?: { internalMagazine: number };
}
const catalogue = JSON.parse(
  readFileSync(new URL("../src/data/core/catalogue.json", import.meta.url), "utf8"),
) as { parts: CatPart[] };

/** Catalogue numbers the HUD shows (they change with balance passes). */
const part = (id: string) => catalogue.parts.find((p) => p.id === `core:${id}`)!;
const KINETIC_MAG = part("magazine.kinetic.s").magazine!.capacity;
const AUTOCANNON_MAG = part("magazine.autocannon.s").magazine!.capacity;
const CANNON_LOADED = part("weapon.cannon.fixed.m").weapon!.internalMagazine;

interface Game {
  openSandbox(): void;
  setTarget(id: string | null): void;
  enemies(): string[];
  screenOfShip(id: string): { x: number; y: number } | null;
  pause(p: boolean): void;
}
const game = <T>(page: Page, fn: (g: Game) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__game)`) as Promise<T>;

test("4.24 select group 2, aim at the dummy, fire: its hull drops in the HUD", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  await game(page, (g) => g.openSandbox());
  await expect(page.getByTestId("wb-group-1")).toBeVisible();
  const target = (await game(page, (g) => g.enemies()))[0]!;
  await game(page, (g) => g.setTarget(g.enemies()[0]!));
  await expect(page.getByTestId("target")).toContainText("Mule");
  await expect(page.getByTestId("target-hull")).toContainText("100%");

  // Let the camera settle on the ship + target framing before aiming at screen coordinates.
  await page.waitForTimeout(1200);
  await page.keyboard.press("2");
  await expect(page.getByTestId("wb-group-2")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("wb-group-1")).toHaveAttribute("aria-pressed", "false");

  const box = (await page.locator("#view").boundingBox())!;
  const aimAtTarget = async () => {
    const p = (await page.evaluate(`window.__game.screenOfShip(${JSON.stringify(target)})`)) as {
      x: number;
      y: number;
    };
    await page.mouse.move(box.x + p.x, box.y + p.y);
  };
  await aimAtTarget();
  await page.mouse.down();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    await aimAtTarget();
  }
  await page.mouse.up();
  await page.screenshot({ path: "test-results/m4-combat.png" });
  await expect
    .poll(
      async () => Number((await page.getByTestId("target-hull").innerText()).match(/(\d+)%/)?.[1] ?? 100),
      { timeout: 10_000 },
    )
    .toBeLessThan(100);
  // Group 2 ammo was used; group 1 (fixed cannon, unselected) still full.
  await expect(page.getByTestId("wb-group-1")).toContainText(`${CANNON_LOADED}/${CANNON_LOADED}`);
  await expect(page.getByTestId("ammo-kinetic-120")).toHaveText(String(KINETIC_MAG));
  expect(Number(await page.getByTestId("ammo-autocannon-30").textContent())).toBeLessThan(AUTOCANNON_MAG);
  expect(errors).toEqual([]);
});

test("G cycles the selected group's mode", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  await game(page, (g) => g.openSandbox());
  await expect(page.getByTestId("wb-mode-1")).toHaveText("MANUAL");
  await page.keyboard.press("g");
  await expect(page.getByTestId("wb-mode-1")).toHaveText("HOLD");
  await page.keyboard.press("g");
  await expect(page.getByTestId("wb-mode-1")).toHaveText("AI");
  // A click on the mode badge cycles it too, and the card shows the group's settings.
  await page.getByTestId("wb-mode-1").click();
  await expect(page.getByTestId("wb-mode-1")).toHaveText("MANUAL");
  await expect(page.getByTestId("wb-settings-1")).toContainText("range");
});
