import { expect, test, type Page } from "@playwright/test";

/** Objectives, battle reports, replays and strategy orders (docs/objectives.md, docs/battle-report.md). */

type G = {
  __game: {
    mode: string;
    toEditor(): void;
    battle(): { status: string } | null;
    world: { tick: number } | null;
  };
  __scenarioEditor: { model: { load(s: unknown): void }; render(): void };
};

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
};

test("a scenario battle is recorded: the report and the replay open from the replays list", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = errorsOf(page);
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.getByTestId("btn-scenarios").click();
  await page.getByTestId("scenario-s17-hold-the-beacon").click();
  await expect(page.getByTestId("scenario-objective")).toContainText("Hold Beacon for 60 s");
  await page.getByTestId("btn-fleet-suggested").click();
  await page.getByTestId("btn-start-battle").click();
  await expect(page.getByTestId("objective")).toContainText("hold Beacon");
  await page.waitForFunction(() => ((window as unknown as G).__game.world?.tick ?? 0) > 120);
  // Leaving the battle keeps its recording.
  await page.evaluate(() => (window as unknown as G).__game.toEditor());
  await page.getByTestId("btn-replays").click();
  const list = page.getByTestId("replay-list");
  await expect(list).toContainText("Hold the beacon");
  await expect(list).toContainText("left early");
  await list.locator("[data-testid^=replay-report-]").first().click();
  const report = page.getByTestId("report-dialog");
  await expect(report).toBeVisible();
  await expect(report).toContainText("Your ships");
  await expect(report).toContainText("Enemy");
  await expect(page.getByTestId("report-chart")).toBeVisible();
  await page.getByTestId("report-watch").click();
  await expect(report).toBeHidden();
  await expect(page.getByTestId("replays-dialog")).toBeHidden();
  await expect(page.getByTestId("objective")).toContainText("hold Beacon");
  await page.waitForFunction(() => ((window as unknown as G).__game.world?.tick ?? 0) > 60);
  expect(await page.evaluate(() => (window as unknown as G).__game.mode)).toBe("flight");
  expect(errors).toEqual([]);
});

test("strategy: rules of engagement, disengage through the jump point, and the report at the end", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = errorsOf(page);
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.getByTestId("btn-scenario-editor").click();
  // A small breakout: three ships of yours (team 0) and a jump point close by, one far-off enemy.
  await page.evaluate(() => {
    const se = (window as unknown as G).__scenarioEditor;
    se.model.load({
      id: "e2e-breakout",
      name: "E2E breakout",
      description: "",
      budget: 0,
      maxPlayerShips: 0,
      arena: { width: 8000, height: 6000, asteroids: [], gravityWells: [] },
      playerSpawns: [],
      enemies: [
        { designId: "fleet-wasp", aiProfile: "balanced", spawn: { position: [-2000, 0], angle: 0 }, team: 0 },
        {
          designId: "fleet-wasp",
          aiProfile: "balanced",
          spawn: { position: [-2000, 300], angle: 0 },
          team: 0,
        },
        {
          designId: "fleet-maul",
          aiProfile: "balanced",
          spawn: { position: [3500, 2500], angle: 180 },
          team: 1,
        },
      ],
      objective: { type: "breakout", zone: { position: [-1200, 150], radius: 500, label: "Jump point" } },
      seed: 3,
    });
    se.render();
  });
  await page.getByTestId("sc-command").click();
  await expect(page.getByTestId("st-objective")).toContainText("break out through Jump point");
  await expect(page.locator(".st-zone-label.exit")).toHaveText("Jump point");
  await page.keyboard.press("Control+a");
  await page.getByTestId("st-roe").selectOption("hold");
  await expect(page.getByTestId("strategy-panel")).toContainText("hold fire");
  await page.getByTestId("st-disengage").click();
  await expect(page.getByTestId("strategy-panel")).toContainText("disengaging");
  for (let i = 0; i < 3; i++) await page.getByTestId("st-faster").click();
  const banner = page.getByTestId("strategy-banner");
  await expect(banner).toBeVisible({ timeout: 90_000 });
  await expect(banner).toContainText("Victory");
  await expect(banner).toContainText("2 ships broke out");
  await banner.getByTestId("btn-report").click();
  await expect(page.getByTestId("report-dialog")).toContainText("jumped out");
  expect(errors).toEqual([]);
});
