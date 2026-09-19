import { expect, test } from "@playwright/test";

import { normalizeBaroHistory, type BaroHistory } from "../config/shared/baroHistory";
import { DB_GET_WORLD_STATE, INVENTORY_UPDATED } from "../config/shared/ipcChannels";
import type { RawInventoryData } from "../src/types/inventory";
import type { WorldState } from "../src/types/world";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

const primedFlow = "/Lotus/Upgrades/Mods/Warframe/Expert/AvatarPowerMaxModExpert";
const second = "/Lotus/Weapons/BaroPlannerFixtureWeapon";
const future = "/Lotus/Types/Items/BaroPlannerFutureItem";
const ducats = "/Lotus/Types/Items/MiscItems/PrimeBucks";

interface BaroTestMain {
  baroTestWorld: WorldState;
}

for (const scenario of ["missing", "unavailable", "empty", "cached"] as const) {
  test(`Baro history coverage distinguishes ${scenario} responses`, async () => {
    test.setTimeout(180_000);
    const history: BaroHistory = {
      version: 1,
      updatedAt: Date.now() - 7_200_000,
      coverageStart: null,
      visits: [],
      lastSeen: [],
    };
    let harness: ElectronTestHarness | undefined;
    try {
      harness = await launchElectronTestHarness("wfh-baro-availability-", {
        storage: scenario === "cached" ? { "baro-history-v1": JSON.stringify(history) } : {},
        onPage: async (page) => {
          await page.addInitScript(
            ({ scenario, history }) => {
              const nativeFetch = window.fetch.bind(window);
              window.fetch = (input, init) => {
                const url =
                  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
                if (new URL(url, location.href).pathname !== "/v1/baro-history")
                  return nativeFetch(input, init);
                return Promise.resolve(
                  new Response(JSON.stringify({ ok: true, data: history }), {
                    status: scenario === "empty" ? 200 : scenario === "missing" ? 404 : 503,
                    headers: { "content-type": "application/json" },
                  }),
                );
              };
            },
            { scenario, history },
          );
        },
      });
      const { page } = harness;
      await openView(page, "world");
      await page.locator('[data-tour-tab="baro"]').click();
      const panel = page.locator("[data-baro-planner]");
      const error = panel.locator("[data-baro-error]");
      if (scenario === "empty") {
        await expect(panel.locator("[data-baro-refresh]")).toBeDisabled();
        await expect(error).toHaveCount(0);
      } else {
        await expect(error).toContainText(scenario === "cached" ? "saved records" : "unavailable");
      }
      if (scenario === "empty" || scenario === "cached") {
        await expect(panel.locator("[data-baro-coverage]")).toContainText(
          "No visits have been recorded yet",
        );
      } else {
        await expect(panel.locator("[data-baro-coverage]")).toHaveCount(0);
        await expect(panel).not.toContainText("No visits have been recorded yet");
      }
      await page.screenshot({
        path: test.info().outputPath(`baro-${scenario}.png`),
        animations: "disabled",
      });
    } finally {
      await closeElectronTestHarness(harness);
    }
  });
}

test("Baro plans a combined basket, preserves wishes and separates recorded prices", async () => {
  test.setTimeout(180_000);
  const testInfo = test.info();
  const now = Date.now();
  const activation = new Date(now - 300_000).toISOString();
  const world: WorldState = {
    voidTrader: {
      activation,
      expiry: new Date(now + 3_600_000).toISOString(),
      location: "Fixture Relay",
      inventory: [
        { uniqueName: primedFlow, item: "Primed Flow", ducats: 60, credits: 60_000 },
        { uniqueName: second, item: "Fixture Weapon", ducats: 60, credits: 60_000 },
      ],
    },
  };
  const history: BaroHistory = {
    version: 1,
    updatedAt: now,
    coverageStart: now - 30 * 86_400_000,
    visits: [
      {
        id: "fixture-previous-visit",
        activation: now - 14 * 86_400_000,
        expiry: now - 12 * 86_400_000,
        node: "Earlier Fixture Relay",
        items: [{ uniqueName: primedFlow, ducats: 10, credits: 10_000 }],
      },
    ],
    lastSeen: [
      {
        uniqueName: primedFlow,
        ducats: 10,
        credits: 10_000,
        visitId: "fixture-previous-visit",
        lastSeen: now - 14 * 86_400_000,
      },
    ],
  };
  expect(normalizeBaroHistory(history)).not.toBeNull();
  const inventory: RawInventoryData = {
    Suits: [],
    RegularCredits: 100_000,
    MiscItems: [{ ItemType: ducats, ItemCount: 100 }],
    Upgrades: [{ ItemType: primedFlow, UpgradeFingerprint: JSON.stringify({ lvl: 5 }) }],
    XPInfo: [{ ItemType: second, XP: 450_000 }],
  };
  let harness: ElectronTestHarness | undefined;
  const pageErrors: string[] = [];
  try {
    harness = await launchElectronTestHarness("wfh-baro-planner-", {
      inventory,
      storage: {
        "baro-history-v1": JSON.stringify(history),
        "baro-wishlist-v1": JSON.stringify({ [primedFlow]: 1, [second]: 1, [future]: 1 }),
        "baro-wishlist-alerts": "0",
      },
      onPage: async (page) => {
        page.on("pageerror", (error) => pageErrors.push(error.message));
        // Electron exposes route.fulfill responses as status 0 here; keep production HTTP checks.
        await page.addInitScript((fixture) => {
          const nativeFetch = window.fetch.bind(window);
          const scope = window as unknown as { baroHistoryFixtureRequests: number };
          scope.baroHistoryFixtureRequests = 0;
          window.fetch = (input, init) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (new URL(url, location.href).pathname !== "/v1/baro-history")
              return nativeFetch(input, init);
            scope.baroHistoryFixtureRequests += 1;
            return Promise.resolve(
              new Response(JSON.stringify({ ok: true, data: fixture }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          };
        }, history);
      },
    });
    const { app, page } = harness;
    await evaluateInMain(
      app,
      ({ ipcMain }, { channel, world }) => {
        const scope = globalThis as unknown as BaroTestMain;
        scope.baroTestWorld = world;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => scope.baroTestWorld);
      },
      { channel: DB_GET_WORLD_STATE, world },
    );
    await setLayoutViewport(page, 1440, 1100);
    async function openPlanner(): Promise<void> {
      await openView(page, "world");
      await page.locator('#content .view.active [data-tour-tab="baro"]').click();
      await expect(page.locator("[data-baro-planner]")).toBeVisible();
    }
    async function replaceWorld(value: WorldState): Promise<void> {
      await evaluateInMain(
        app,
        (_electron, next) => {
          (globalThis as unknown as BaroTestMain).baroTestWorld = next;
        },
        value,
      );
      await openView(page, "settings");
      await openPlanner();
    }
    // The load starts when the World view mounts and disables the button for the 30s
    // cooldown in stores/baro.ts. A paused clock stops that cooldown from draining
    // while it is asserted; fastForward below runs the timers suspended with it.
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1_000);
    await openPlanner();
    const panel = page.locator("[data-baro-planner]");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { baroHistoryFixtureRequests: number })
              .baroHistoryFixtureRequests,
        ),
      )
      .toBeGreaterThan(0);
    await expect(panel.locator("[data-baro-refresh]")).toBeDisabled();
    await expect(panel.locator("[data-baro-error]")).toHaveCount(0);
    const requests = await page.evaluate(
      () =>
        (window as unknown as { baroHistoryFixtureRequests: number }).baroHistoryFixtureRequests,
    );
    await panel
      .locator("[data-baro-refresh]")
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { baroHistoryFixtureRequests: number })
              .baroHistoryFixtureRequests,
        ),
      )
      .toBe(requests);
    await page.clock.fastForward(61_000);
    await expect(panel.locator("[data-baro-refresh]")).toBeEnabled();
    await panel.locator("[data-baro-refresh]").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { baroHistoryFixtureRequests: number })
              .baroHistoryFixtureRequests,
        ),
      )
      .toBe(requests + 1);
    await expect(panel.locator("[data-baro-refresh]")).toBeDisabled();
    await expect(panel.locator("[data-baro-error]")).toHaveCount(0);
    await page.clock.resume();
    const row = (uniqueName: string) => panel.locator(`[data-baro-row="${uniqueName}"]`);
    const quantity = (uniqueName: string) => panel.locator(`[data-baro-quantity="${uniqueName}"]`);
    const ducatBudget = panel.locator('[data-baro-budget="ducats"]');
    const creditBudget = panel.locator('[data-baro-budget="credits"]');
    await expect(ducatBudget.locator("p").first()).toHaveText("120");
    await expect(creditBudget.locator("p").first()).toHaveText("120,000");
    await expect(ducatBudget).toContainText("Balance: 100");
    await expect(ducatBudget).toContainText("Still needed: 20");
    await expect(creditBudget).toContainText("Still needed: 20,000");
    await expect(panel.locator("[data-baro-future-wishes]")).toContainText("1 wishlist items");
    await expect(row(primedFlow).locator("td").nth(2)).toHaveText("60");
    await expect(row(primedFlow).locator("[data-baro-last-seen]")).toHaveText(
      "Available this visit",
    );
    await page.screenshot({
      path: testInfo.outputPath("baro-current-plan.png"),
      animations: "disabled",
    });

    await panel.locator("[data-baro-unowned]").check();
    await expect(row(primedFlow)).toHaveCount(0);
    await expect(row(second)).toBeVisible();
    await panel.locator("[data-baro-unowned]").uncheck();
    await panel.locator(`[data-baro-open="${primedFlow}"]`).click();
    const modal = page.locator('[role="dialog"]');
    await expect(modal.locator(`[data-baro-last-seen="${primedFlow}"]`)).toHaveText(
      "Available this visit",
    );
    await expect(modal).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: testInfo.outputPath("baro-item-detail.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");

    await panel.locator('[data-baro-filter="history"]').click();
    await panel.locator("[data-baro-visit]").selectOption("fixture-previous-visit");
    await expect(panel.locator("[data-baro-row]")).toHaveCount(1);
    await expect(row(primedFlow).locator("td").nth(2)).toHaveText("10");
    await expect(row(primedFlow).locator("td").nth(3)).toHaveText("10,000");
    await expect(row(primedFlow)).toContainText("Recorded price");
    await expect(ducatBudget.locator("p").first()).toHaveText("120");
    await page.screenshot({
      path: testInfo.outputPath("baro-recorded-visit.png"),
      animations: "disabled",
    });

    await panel.locator('[data-baro-filter="wishlist"]').click();
    await expect(panel.locator("[data-baro-row]")).toHaveCount(3);
    await expect(row(future).locator("[data-baro-last-seen]")).toHaveText(
      "No recorded Baro history",
    );
    await quantity(second).fill("2");
    await quantity(second).blur();
    await expect(ducatBudget.locator("p").first()).toHaveText("180");
    await quantity(future).fill("0");
    await quantity(future).blur();
    await expect(row(future)).toHaveCount(0);

    await page.locator("[data-popout-open]").click();
    await expect
      .poll(() => app.windows().some((win) => win.url().includes("popout=view:world")))
      .toBe(true);
    const popout = app.windows().find((win) => win.url().includes("popout=view:world"))!;
    popout.on("pageerror", (error) => pageErrors.push(error.message));
    await popout.locator('[data-tour-tab="baro"]').click();
    const otherQuantity = popout.locator(`[data-baro-quantity="${primedFlow}"]`);
    await expect(otherQuantity).toBeVisible();
    expect(await page.evaluate(() => navigator.locks.request("wfhelper:test", () => true))).toBe(
      true,
    );
    expect(await popout.evaluate(() => navigator.locks.request("wfhelper:test", () => true))).toBe(
      true,
    );
    await Promise.all([quantity(second).fill("3"), otherQuantity.fill("2")]);
    await Promise.all([quantity(second).blur(), otherQuantity.blur()]);
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("baro-wishlist-v1") ?? "{}")))
      .toMatchObject({ [second]: 3, [primedFlow]: 2 });
    await expect(otherQuantity).toHaveValue("2");
    await expect(quantity(primedFlow)).toHaveValue("2");
    await popout.close();
    await quantity(primedFlow).fill("1");
    await quantity(primedFlow).blur();
    await quantity(second).fill("2");
    await quantity(second).blur();
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const saved = JSON.parse(localStorage.getItem("baro-wishlist-v1") ?? "{}");
          return saved[key] ?? null;
        }, future),
      )
      .toBeNull();
    await page.screenshot({
      path: testInfo.outputPath("baro-wishlist.png"),
      animations: "disabled",
    });

    await expect(panel.locator("[data-baro-arrival-alerts]")).not.toBeChecked();
    await panel.locator("[data-baro-arrival-alerts]").check();
    const seen = () =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("baro-wishlist-seen") ?? "[]") as string[],
      );
    await expect.poll(seen).toHaveLength(2);
    const arrivalKeys = await seen();
    await replaceWorld(world);
    expect(await seen()).toEqual(arrivalKeys);
    await expect(quantity(second)).toHaveValue("2");
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible();
    await openPlanner();
    await expect(quantity(second)).toHaveValue("2");
    await expect(panel.locator("[data-baro-arrival-alerts]")).toBeChecked();
    expect(await seen()).toEqual(arrivalKeys);
    await expect(row(future)).toHaveCount(0);

    await replaceWorld({
      voidTrader: { ...world.voidTrader, expiry: new Date(now - 60_000).toISOString() },
    });
    await expect(ducatBudget.locator("p").first()).toHaveText("0");
    await expect(creditBudget.locator("p").first()).toHaveText("0");
    await expect(row(primedFlow).locator("[data-baro-last-seen]")).toContainText("Last recorded:");
    await panel.locator('[data-baro-filter="current"]').click();
    await expect(panel.locator("[data-baro-row]")).toHaveCount(0);

    await replaceWorld({
      voidTrader: {
        ...world.voidTrader,
        inventory: [{ uniqueName: primedFlow, item: "Primed Flow", credits: 60_000 }],
      },
    });
    await expect(panel.locator("[data-baro-unknown-costs]")).toBeVisible();
    await expect(ducatBudget.locator("p").first()).toHaveText("Unknown");
    await expect(creditBudget.locator("p").first()).toHaveText("60,000");
    await expect(ducatBudget).not.toContainText("Still needed:");
    await replaceWorld(world);
    await evaluateInMain(
      app,
      ({ BrowserWindow }, channel) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.webContents.getURL().includes("renderer/dist/index.html"))
            win.webContents.send(channel, { Suits: [] });
        }
      },
      INVENTORY_UPDATED,
    );
    await expect(ducatBudget).toContainText("Balance: Unknown");
    await expect(creditBudget).toContainText("Balance: Unknown");
    await expect(ducatBudget).not.toContainText("Still needed:");
    expect(pageErrors).toEqual([]);
  } finally {
    await closeElectronTestHarness(harness);
  }
});
