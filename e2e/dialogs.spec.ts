import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  return errors;
}

test("library search filters designs; ✕ closes the dialog", async ({ page }) => {
  const errors = await open(page);
  await page.getByTestId("btn-library").click();
  const lib = page.getByTestId("library-dialog");
  await expect(lib).toBeVisible();
  await expect(lib.locator("[data-design]:visible").first()).toBeVisible();
  await page.getByTestId("library-search").fill("frigate");
  const names = await lib.locator("[data-design]:visible .name").allTextContents();
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) expect(n.toLowerCase()).toContain("frigate");
  await page.getByTestId("library-dialog-x").click();
  await expect(lib).toBeHidden();
  expect(errors).toEqual([]);
});

test("roster: search, and a promotion trains the chosen stat", async ({ page }) => {
  const errors = await open(page);
  await page.getByTestId("btn-crew").click();
  const roster = page.getByTestId("roster-dialog");
  await expect(roster).toBeVisible();
  await page.getByTestId("roster-new").click();
  const card = roster.locator(".roster-officer").last();
  const id = (await card.getAttribute("data-officer"))!;
  const name = await card.locator(".roster-name").inputValue();
  const read = () =>
    page.evaluate(
      (oid) =>
        (
          JSON.parse(localStorage.getItem("space-game.roster.v1")!) as {
            officers: { id: string; level: number; training?: string[] }[];
          }
        ).officers.find((o) => o.id === oid),
      id,
    );
  let before = await read();
  if (before!.level >= 5) {
    await page.getByTestId(`officer-level-${id}`).selectOption("1");
    before = await read();
  }
  await page.getByTestId(`officer-promote-${id}`).click();
  const promo = page.locator("dialog[open][data-testid=promotion-dialog]");
  await expect(promo).toBeVisible();
  await page.getByTestId("promotion-cooling").check();
  await expect(page.getByTestId("promotion-after")).toContainText(`level ${before!.level + 1}`);
  await page.getByTestId("promotion-ok").click();
  await expect(promo).toHaveCount(0);
  const stored = await page.evaluate(
    (oid) =>
      (
        JSON.parse(localStorage.getItem("space-game.roster.v1")!) as {
          officers: { id: string; level: number; training: string[] }[];
        }
      ).officers.find((o) => o.id === oid),
    id,
  );
  expect(stored?.level).toBe(before!.level + 1);
  expect(stored?.training?.at(-1)).toBe("cooling");
  expect(stored?.training).toHaveLength(before!.level);
  // Search by the officer's name keeps it; nonsense hides every officer.
  await page.getByTestId("roster-search").fill(name.split(" ").at(-1)!);
  await expect(roster.locator(`[data-officer="${id}"]`)).toBeVisible();
  await page.getByTestId("roster-search").fill("zzzz-nobody");
  await expect(roster.locator(".roster-officer:visible")).toHaveCount(0);
  await page.getByTestId("roster-dialog-x").click();
  await expect(roster).toBeHidden();
  expect(errors).toEqual([]);
});
