import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

interface EditorHandle {
  attachPoint(uid: string, edge: number, distance: number): { x: number; y: number };
  toScreen(p: { x: number; y: number }): { x: number; y: number };
}

/** Clicks a palette part, then clicks the canvas at a screen point computed by the editor. */
async function place(page: Page, partId: string, where: (e: EditorHandle) => { x: number; y: number }) {
  await pick(page, partId);
  const box = (await page.locator("#view").boundingBox())!;
  const pt = (await page.evaluate(`(${where.toString()})(window.__editor)`)) as { x: number; y: number };
  await page.mouse.move(box.x + pt.x, box.y + pt.y, { steps: 3 });
  await page.mouse.click(box.x + pt.x, box.y + pt.y);
}

/** Finds a part with the palette search (categories may be collapsed) and starts placing it. */
async function pick(page: Page, partId: string) {
  await page.getByTestId("palette-search").fill(partId);
  await page.getByTestId(`palette-${partId}`).click();
  await page.getByTestId("palette-search").fill("");
  await page.getByTestId("palette-search").blur();
}

/** All stat values (excludes the panel heading, which shows an unsaved marker). */
const statValues = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-testid^='stat-']")]
      .map((e) => `${(e as HTMLElement).dataset.testid}=${e.textContent}`)
      .join("\n"),
  );

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  return errors;
}

/** Builds the 10-part test corvette from an empty canvas through the UI (plan test 2.32). */
async function buildCorvette(page: Page) {
  await page.getByTestId("btn-new").click();
  await page.getByTestId("design-name").fill("Test Corvette");
  await page.getByTestId("design-name").press("Enter");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await place(page, "core:command.s", (e) => e.toScreen({ x: 0, y: 0 })); // p1
  await place(page, "core:tank.fuel.s", (e) => e.attachPoint("p1", 3, 0.5)); // p2 behind command
  await place(page, "core:engine.main.s", (e) => e.attachPoint("p2", 3, 0.5)); // p3 behind tank
  await place(page, "core:hull.wedge.m", (e) => e.attachPoint("p1", 1, 1)); // p4 nose
  await page.keyboard.press("Escape");
  await page.keyboard.press("m"); // mirror mode: each placement adds its twin
  await expect(page.getByTestId("btn-mirror")).toHaveClass(/on/);
  await place(page, "core:hull.square.s", (e) => e.attachPoint("p1", 2, 0.5)); // p5 + p6
  await place(page, "core:hull.square.s", (e) => e.attachPoint("p5", 2, 0.5)); // p7 + p8
  await place(page, "core:armor.square.s", (e) => e.attachPoint("p2", 2, 0.5)); // p9 + p10
  await page.keyboard.press("Escape");
}

test("2.32 build a valid 10-part ship from an empty canvas, save, reload: still there", async ({ page }) => {
  test.setTimeout(90_000); // many placements, rendered with software WebGL on CI
  const errors = await open(page);
  await buildCorvette(page);
  await expect(page.getByTestId("stat-parts")).toHaveText("10");
  await expect(page.getByTestId("issue-count")).toContainText("0 errors", { timeout: 15_000 });
  await page.getByTestId("btn-save").click();
  await expect(page.getByTestId("toasts")).toContainText("Saved");
  const mass = await page.getByTestId("stat-mass").textContent();

  await page.reload();
  await expect(page.getByTestId("stat-parts")).toHaveText("10");
  await expect(page.getByTestId("design-name")).toHaveValue("Test Corvette");
  await expect(page.getByTestId("stat-mass")).toHaveText(mass!);
  await expect(page.getByTestId("issue-count")).toContainText("0 errors");

  // The saved design flies.
  await page.getByTestId("btn-test-flight").click();
  await expect(page.getByTestId("speed")).toBeVisible();
  await page.keyboard.down("w");
  await expect.poll(async () => Number(await page.getByTestId("speed").textContent())).toBeGreaterThan(5);
  await page.keyboard.up("w");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("stat-parts")).toHaveText("10");
  expect(errors).toEqual([]);
});

test("2.33 export a file, import it in a fresh browser profile: identical stats", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000); // two profiles, each rendering with software WebGL
  await open(page);
  await buildCorvette(page);
  const stats = await statValues(page);
  await page.getByTestId("btn-export").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("btn-export-file").click(),
  ]);
  expect(download.suggestedFilename()).toBe("Test_Corvette.ship.json");
  const file = "test-results/corvette.ship.json";
  await download.saveAs(file);
  expect(JSON.parse(readFileSync(file, "utf8")).format).toBe("spacegame.ship");

  const fresh = await browser.newContext();
  const page2 = await fresh.newPage();
  await open(page2);
  await page2.getByTestId("btn-import").click();
  await page2.getByTestId("import-file").setInputFiles(file);
  await expect(page2.getByTestId("import-result")).toContainText("Test Corvette");
  await page2.getByTestId("btn-do-import").click();
  await expect(page2.getByTestId("design-name")).toHaveValue("Test Corvette");
  expect(await statValues(page2)).toBe(stats);
  await fresh.close();
});

test("2.34 drag-drop import and clipboard paste (SG1 code) import", async ({ browser }) => {
  test.setTimeout(120_000); // three profiles, each rendering with software WebGL
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await open(page);
  await buildCorvette(page);
  const stats = await statValues(page);
  await page.getByTestId("btn-export").click();
  await page.getByTestId("btn-copy-code").click();
  await expect(page.getByTestId("toasts")).toContainText("Share code copied");
  const code = await page.evaluate(() => navigator.clipboard.readText());
  expect(code).toMatch(/^SG1:[A-Za-z0-9_-]+$/);
  await page.getByTestId("btn-export").click();
  await page.getByTestId("btn-copy-json").click();
  const json = await page.evaluate(() => navigator.clipboard.readText());
  await ctx.close();

  // Drag-drop a file into a fresh profile.
  const dropCtx = await browser.newContext();
  const dropPage = await dropCtx.newPage();
  await open(dropPage);
  await dropPage.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], "corvette.ship.json", { type: "application/json" }));
    document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, json);
  await expect(dropPage.getByTestId("import-result")).toContainText("Test Corvette");
  await dropPage.getByTestId("btn-do-import").click();
  await expect(dropPage.getByTestId("design-name")).toHaveValue("Test Corvette");
  expect(await statValues(dropPage)).toBe(stats);
  await dropCtx.close();

  // Paste the share code into another fresh profile.
  const pasteCtx = await browser.newContext();
  const pastePage = await pasteCtx.newPage();
  await open(pastePage);
  await pastePage.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, code);
  await expect(pastePage.getByTestId("import-result")).toContainText("Test Corvette");
  await pastePage.getByTestId("btn-do-import").click();
  await expect(pastePage.getByTestId("design-name")).toHaveValue("Test Corvette");
  expect(await statValues(pastePage)).toBe(stats);

  // Importing again into the same profile reports the design-id conflict.
  await pastePage.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, code);
  await expect(pastePage.getByTestId("import-conflict")).toBeVisible();
  await pasteCtx.close();
});

test("connection guidance: legend is visible and the status line explains snapping", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("edge-legend")).toContainText("How parts connect");
  await page.getByTestId("btn-new").click();
  await place(page, "core:command.s", (e) => e.toScreen({ x: 0, y: 0 }));
  const status = page.locator(".ed-status");
  await pick(page, "core:hull.square.s");
  const box = (await page.locator("#view").boundingBox())!;
  const at = async (fn: (e: EditorHandle) => { x: number; y: number }) => {
    const pt = (await page.evaluate(`(${fn.toString()})(window.__editor)`)) as { x: number; y: number };
    await page.mouse.move(box.x + pt.x, box.y + pt.y, { steps: 2 });
  };
  await at((e) => e.attachPoint("p1", 2, 0.6));
  await expect(status).toContainText("✓ Connects to Command module");
  await expect(status).toHaveAttribute("data-level", "ok");
  await at((e) => e.toScreen({ x: 0, y: 4 }));
  await expect(status).toContainText("Not connected");
  await page.keyboard.press("Escape");
  await expect(status).not.toHaveAttribute("data-level", /.+/);
});
