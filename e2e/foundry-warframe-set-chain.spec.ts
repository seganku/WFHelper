import fs from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

interface ChainSeed {
  mainBp: string;
  partBps: string[];
  /** The part the main recipe names, index-aligned with partBps. */
  partIngredients: string[];
  misc: Array<{ ItemType: string; ItemCount: number }>;
}

async function readChainSeed(page: Page): Promise<ChainSeed> {
  const seed = (await page.evaluate(async () => {
    const db = (await window.api.getItemDatabase()) as unknown as Record<
      string,
      {
        name?: string;
        recipe?: {
          blueprintUniqueName?: string;
          ingredients?: Array<{ uniqueName: string; count: number }>;
        };
      }
    >;
    const frame = Object.values(db).find((entry) => entry?.name === "Yareli");
    if (!frame?.recipe?.blueprintUniqueName) return null;
    const partBps: string[] = [];
    const partIngredients: string[] = [];
    const misc: Array<{ ItemType: string; ItemCount: number }> = [];
    for (const ing of frame.recipe.ingredients ?? []) {
      const part = db[ing.uniqueName];
      if (part?.recipe?.blueprintUniqueName) {
        partBps.push(part.recipe.blueprintUniqueName);
        partIngredients.push(ing.uniqueName);
        for (const sub of part.recipe.ingredients ?? []) {
          misc.push({ ItemType: sub.uniqueName, ItemCount: sub.count * ing.count });
        }
      } else {
        misc.push({ ItemType: ing.uniqueName, ItemCount: ing.count });
      }
    }
    return { mainBp: frame.recipe.blueprintUniqueName, partBps, partIngredients, misc };
  })) as ChainSeed | null;

  expect(seed).not.toBeNull();
  expect(seed!.partBps.length).toBeGreaterThan(1);
  return seed!;
}

test.describe("Foundry buildable-set chain", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-wf-chain-", { inventory: { Suits: [] } });
    await harness.page.locator('#sidebar [data-view="foundry"]').click();
    await expect(harness.page.locator("[data-foundry-state]")).toBeVisible({ timeout: 90_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  const write = (seed: ChainSeed, recipes: string[]) => {
    // A changed file re-triggers the watcher, which is what refills the stores.
    fs.writeFileSync(
      path.join(harness!.helperDir, "inventory.json"),
      JSON.stringify({
        Suits: [],
        Recipes: recipes.map((ItemType) => ({ ItemType, ItemCount: 1 })),
        MiscItems: seed.misc,
      }),
    );
  };

  test("a frame with craftable parts counts as a buildable set", async () => {
    const page = harness!.page;
    const seed = await readChainSeed(page);

    write(seed, [seed.mainBp, ...seed.partBps]);
    await expect
      .poll(() => page.locator(".resource-card").count(), { timeout: 60_000 })
      .toBeGreaterThan(0);

    await page.locator('[data-tour-tab="cat:Warframe"]').click();
    await page.locator("[data-foundry-state]").selectOption("buildable_sets");
    await expect.poll(() => page.locator(".resource-card").count()).toBe(1);
    await expect(page.locator(".resource-card")).toContainText("Yareli");

    write(seed, [seed.mainBp, ...seed.partBps.slice(1)]);
    await expect.poll(() => page.locator(".resource-card").count(), { timeout: 60_000 }).toBe(0);

    await page.locator("[data-foundry-state]").selectOption("all");
    await page.locator('[data-tour-tab="all"]').click();
  });

  test("a part whose blueprint is held but not built carries the blueprint mark", async () => {
    const page = harness!.page;
    const seed = await readChainSeed(page);
    const [heldPart, missingPart] = seed.partIngredients;

    write(seed, [seed.mainBp, seed.partBps[0]]);
    const held = page.locator(`[data-ingredient="${heldPart}"]`);
    await expect(held).toHaveAttribute("data-part-state", "blueprint", { timeout: 60_000 });
    await expect(page.locator(`[data-ingredient="${missingPart}"]`)).toHaveAttribute(
      "data-part-state",
      "missing",
    );

    fs.writeFileSync(
      path.join(harness!.helperDir, "inventory.json"),
      JSON.stringify({
        Suits: [],
        Recipes: [{ ItemType: seed.mainBp, ItemCount: 1 }],
        MiscItems: [...seed.misc, { ItemType: heldPart, ItemCount: 1 }],
      }),
    );
    await expect(held).toHaveAttribute("data-part-state", "owned", { timeout: 60_000 });

    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("foundry-part-blueprint-mark.png"),
    });
  });
});
