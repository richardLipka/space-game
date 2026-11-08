import { expect, test } from "@playwright/test";

test("app opens in the editor; the sandbox starts and the simulation advances", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  await expect(page.getByTestId("stat-parts")).toBeVisible();
  await page.getByTestId("btn-sandbox").click();
  const tick = page.getByTestId("tick");
  await expect(tick).toBeVisible();
  const first = Number(await tick.textContent());
  await expect.poll(async () => Number(await tick.textContent())).toBeGreaterThan(first + 10);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toBeVisible();
  expect(errors).toEqual([]);
});
