import fs from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Rows must land inside the default year-to-date window whatever day CI runs on,
// so they sit two days back but never before the second of January.
const NOW = new Date();
const YEAR = NOW.getFullYear();
const SEEDED_AT = new Date(
  Math.max(NOW.getTime() - 2 * 86_400_000, new Date(YEAR, 0, 2).getTime()),
).toISOString();

const LEDGER_ROWS = [
  {
    id: "live-a",
    date: SEEDED_AT,
    type: "sale",
    platChange: 10,
    items: [{ internalName: "", displayName: "Forma", count: 1, direction: "given" }],
    partner: "Kestrel",
  },
  {
    id: "live-b",
    date: SEEDED_AT,
    type: "purchase",
    platChange: 25,
    items: [{ internalName: "", displayName: "Orokin Cell", count: 1, direction: "received" }],
    partner: "Vor",
  },
  {
    id: "live-arcane-r0",
    date: SEEDED_AT,
    type: "sale",
    platChange: 20,
    items: [
      {
        internalName: "",
        displayName: "Arcane Energize (RANK 0)",
        count: 1,
        direction: "given",
        wfmSlug: "arcane_energize",
      },
    ],
    partner: "Darvo",
  },
  {
    id: "live-arcane-r5",
    date: SEEDED_AT,
    type: "sale",
    platChange: 200,
    items: [
      {
        internalName: "",
        displayName: "Arcane Energize (RANK 5)",
        count: 1,
        direction: "given",
        wfmSlug: "arcane_energize",
      },
    ],
    partner: "Darvo",
  },
];

const IMPORT_ROWS = [
  { date: SEEDED_AT, type: "sale", items: "Forma", platinum: 10, partner: "Kestrel" },
  { date: SEEDED_AT, type: "sale", items: "Nitain Extract", platinum: 42, partner: "Teshin" },
];

test.describe("Market analysis", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-analysis-e2e-", {
      userDataFiles: { "trade-log.json": LEDGER_ROWS },
    });
    page = harness.page;
    await openView(page, "analytics");
    await expect(page.locator("[data-analysis-view]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-analysis-row]")).toHaveCount(4, { timeout: 30_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  /** Sets a date bound the way a user types it, optionally clicking a preset in
   *  the same task so the click lands inside the commit debounce window. */
  async function editBound(value: string, thenPreset?: string): Promise<void> {
    await page.evaluate(
      ([next, preset]) => {
        const input = document.querySelector<HTMLInputElement>("[data-analysis-range-from] input");
        if (!input) throw new Error("no from-bound input");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
          ?.set as (this: HTMLInputElement, v: string) => void;
        setter.call(input, next as string);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        if (preset) {
          document
            .querySelector<HTMLButtonElement>(`[data-analysis-range-preset="${preset}"] button`)
            ?.click();
        }
      },
      [value, thenPreset ?? ""],
    );
  }

  test("one arcane sold at two ranks rolls up as two rows that name the rank", async () => {
    const sold = page.locator('[data-analysis-top-items="sold"]');
    await expect(sold).toBeVisible({ timeout: 30_000 });
    for (const rank of [0, 5]) {
      const row = sold.locator(`[data-analysis-item-row="arcane_energize:r${rank}"]`);
      await expect(row).toHaveCount(1);
      await expect(row.locator(`[data-analysis-item-rank="${rank}"]`)).toHaveCount(1);
    }
    await page.screenshot({ path: test.info().outputPath("analytics-arcane-rank.png") });
  });

  test("a debounced bound edit commits, and picking a preset cancels it", async () => {
    const range = page.locator("[data-analysis-range]");

    await editBound(`${YEAR + 1}-01-01`);
    await expect(range).toHaveAttribute("data-analysis-range-current", "custom");
    await expect(page.locator("[data-analysis-row]")).toHaveCount(0);

    await editBound(`${YEAR + 1}-01-01`, "all");
    await page.waitForTimeout(1_000);
    await expect(range).toHaveAttribute("data-analysis-range-current", "all");
    await expect(page.locator("[data-analysis-row]")).toHaveCount(4);
  });

  test("the row editor floors credits and tax at zero", async () => {
    await page.locator('[data-analysis-row="live-a"] button').click();
    const editor = page.locator("[data-analysis-row-editor]");
    await expect(editor).toBeVisible();

    await expect(editor.locator('[data-analysis-field="credits"] input')).toHaveAttribute(
      "min",
      "0",
    );
    await expect(editor.locator('[data-analysis-field="tax"] input')).toHaveAttribute("min", "0");

    const save = editor.locator("[data-analysis-row-editor-save] button");
    await expect(save).toBeEnabled();
    await editor.locator('[data-analysis-field="credits"] input').fill("-5");
    await expect(save).toBeDisabled();
    await editor.locator('[data-analysis-field="credits"] input').fill("5");
    await expect(save).toBeEnabled();
    await editor.locator('[data-analysis-field="tax"] input').fill("-1");
    await expect(save).toBeDisabled();

    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
  });

  test("the import status counts the duplicates the preview already dropped", async () => {
    const importPath = path.join(harness.sandboxDir, "gdpr-trades.json");
    fs.writeFileSync(importPath, JSON.stringify(IMPORT_ROWS));
    await evaluateInMain(
      harness.app,
      (electron, filePath) => {
        electron.dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [filePath],
        })) as never;
      },
      importPath,
    );

    await page.locator("[data-analysis-import] button").click();
    const dialog = page.locator("[data-analysis-import-dialog]");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.locator("[data-analysis-import-apply] button").click();

    await expect(page.locator("[data-analysis-status]")).toHaveText(
      "Imported 1 rows, skipped 1 duplicates.",
      { timeout: 30_000 },
    );
    await expect(page.locator("[data-analysis-row]")).toHaveCount(5);
  });
});

test("analytics summary keeps a long best seller name inside its divided cell", async () => {
  test.setTimeout(180_000);
  const name = "ExtremelyLongUnbrokenBestSellerNameForSummaryWrapping Prime Neuroptics Blueprint";
  const harness = await launchElectronTestHarness("wfh-analysis-long-name-", {
    userDataFiles: {
      "trade-log.json": [
        {
          ...LEDGER_ROWS[0],
          items: [{ internalName: "", displayName: name, count: 1, direction: "given" }],
        },
      ],
    },
  });
  try {
    const { page } = harness;
    await openView(page, "analytics");
    const best = page.locator('[data-analysis-summary] [data-summary-item="best"]');
    await expect(best).toContainText(name);
    for (const width of [1440, 800]) {
      await setLayoutViewport(page, width, 1000);
      const geometry = await best.evaluate((element) => {
        const value = element.querySelectorAll("span")[1];
        const rect = value.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(value);
        const lines = Array.from(range.getClientRects());
        return {
          wraps: lines.length > 1,
          fits: lines.every((line) => line.left >= rect.left - 1 && line.right <= rect.right + 1),
          divider: getComputedStyle(element, "::before").width,
          alignment: getComputedStyle(element).textAlign,
        };
      });
      expect(geometry.wraps).toBe(true);
      expect(geometry.fits).toBe(true);
      expect(geometry.divider).toBe("1px");
      expect(geometry.alignment).toBe("center");
      await page.screenshot({ path: test.info().outputPath(`analytics-long-name-${width}.png`) });
    }
  } finally {
    await closeElectronTestHarness(harness);
  }
});
