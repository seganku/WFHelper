import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

const PART_PREFIX = "/Lotus/Types/Recipes/Weapons/WeaponParts/";
// Tradable parts generate a market slug locally, so the panel renders its
// action row with no network. Enough of them to make the grid scroll.
const PARTS = [
  "AcceltraPrimeBarrel",
  "AcceltraPrimeReceiver",
  "AcceltraPrimeStock",
  "AfurisPrimeBarrel",
  "AfurisPrimeLink",
  "AfurisPrimeReceiver",
  "AkariusPrimeBarrel",
  "AkariusPrimeLink",
  "AkariusPrimeReceiver",
  "AkboltoPrimeBarrel",
  "AkboltoPrimeLink",
  "AkboltoPrimeReceiver",
  "AkjagaraPrimeBarrel",
  "AkjagaraPrimeLink",
  "AkjagaraPrimeReceiver",
  "AksomatiPrimeBarrel",
  "AksomatiPrimeLink",
  "AksomatiPrimeReceiver",
  "AkstilettoPrimeBarrel",
  "AkstilettoPrimeLink",
  "AkstilettoPrimeReceiver",
  "AlternoxPrimeBarrel",
  "AlternoxPrimeReceiver",
  "AlternoxPrimeStock",
  "AstillaPrimeBarrel",
  "AstillaPrimeReceiver",
  "AstillaPrimeStock",
  "BazaPrimeBarrel",
  "BazaPrimeReceiver",
  "BazaPrimeStock",
  "BoarPrimeBarrel",
  "BoarPrimeReceiver",
  "BoarPrimeStock",
  "BoltorPrimeBarrel",
  "BoltorPrimeReceiver",
  "BoltorPrimeStock",
  "BratonPrimeBarrel",
  "BratonPrimeReceiver",
  "BratonPrimeStock",
  "BurstonPrimeBarrel",
  "BurstonPrimeReceiver",
  "BurstonPrimeStock",
  "CedoPrimeBarrel",
  "CedoPrimeReceiver",
  "CedoPrimeStock",
];

function inventory() {
  return {
    Suits: [],
    MiscItems: PARTS.map((part) => ({ ItemType: PART_PREFIX + part, ItemCount: 2 })),
  };
}

interface Reachability {
  scrolled: number;
  buttonTop: number;
  buttonBottom: number;
  viewportHeight: number;
  panelTop: number;
  stickyBottom: number;
  hitsButton: boolean;
}

async function measure(page: Page): Promise<Reachability> {
  return page.evaluate(() => {
    const content = document.querySelector("#content") as HTMLElement;
    const sticky = document.querySelector(".view-sticky-filters") as HTMLElement;
    const panel = document.querySelector("[data-orderbook-panel]") as HTMLElement;
    const button = document.querySelector("[data-orderbook-wfm]") as HTMLElement;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      scrolled: Math.round(content.scrollTop),
      buttonTop: Math.round(rect.top),
      buttonBottom: Math.round(rect.bottom),
      viewportHeight: window.innerHeight,
      panelTop: Math.round(panel.getBoundingClientRect().top),
      stickyBottom: Math.round(sticky.getBoundingClientRect().bottom),
      hitsButton: button === hit || button.contains(hit),
    };
  });
}

test.describe("Inventory order book stays reachable while scrolled", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-orderbook-reach-", { inventory: inventory() });
    page = harness.page;
    await openView(page, "inventory");
    await page.locator('[data-tour-tab="all_parts"]').click();
    await expect(page.locator(".item-card").first()).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  // Never click a listing row here: Whisper and Profile reach the clipboard and
  // the system browser.
  async function resetPanel(): Promise<void> {
    const close = page.locator("[data-orderbook-close]");
    if ((await close.count()) > 0) await close.click();
    await expect(page.locator("[data-orderbook-panel]")).toHaveCount(0);
    await page.locator("#content").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.waitForTimeout(200);
  }

  async function openPanelDeepInTheList(): Promise<void> {
    const cards = page.locator(".item-card");
    await expect.poll(async () => cards.count(), { timeout: 30_000 }).toBeGreaterThan(24);
    // Playwright scrolls the target into view, which leaves the grid deep in the list.
    await cards.nth(24).click();
    await expect(page.locator("[data-orderbook-wfm]")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(400);
  }

  test("the warframe.market action clears the sticky filter band on a wide window", async () => {
    await setLayoutViewport(page, 1280, 700);
    await resetPanel();
    await openPanelDeepInTheList();

    const probe = await measure(page);
    expect(probe.scrolled).toBeGreaterThan(150);
    // A one-pixel tolerance: the band and the panel are laid out on fractional
    // device pixels and the rounding can put them a hair apart either way.
    expect(probe.panelTop).toBeGreaterThanOrEqual(probe.stickyBottom - 1);
    expect(probe.buttonTop).toBeGreaterThanOrEqual(probe.stickyBottom - 1);
    expect(probe.buttonBottom).toBeLessThanOrEqual(probe.viewportHeight);
    expect(probe.hitsButton).toBe(true);
    await expect(page.locator("[data-orderbook-wfm]")).toBeInViewport();
  });

  test("the action stays reachable on a window narrow enough to float the panel", async () => {
    await setLayoutViewport(page, 1000, 640);
    await resetPanel();
    await openPanelDeepInTheList();

    const probe = await measure(page);
    expect(probe.scrolled).toBeGreaterThan(150);
    expect(probe.buttonTop).toBeGreaterThanOrEqual(0);
    expect(probe.buttonBottom).toBeLessThanOrEqual(probe.viewportHeight);
    expect(probe.hitsButton).toBe(true);
  });

  // Runs last: it leaves a fetch stub in the page for the rest of the session.
  test("a bulk buy order is priced per item, not per trade", async () => {
    await setLayoutViewport(page, 1280, 700);
    await resetPanel();

    // 97p buys six arcanes here, so the book must read 16.17p, never 97p.
    await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes("/orders/item/")) return original(input, init);
        return new Response(
          JSON.stringify({
            data: [
              {
                type: "buy",
                platinum: 97,
                quantity: 24,
                perTrade: 6,
                visible: true,
                user: { ingameName: "BulkBuyer", status: "ingame" },
              },
              {
                type: "sell",
                platinum: 30,
                quantity: 1,
                visible: true,
                user: { ingameName: "SingleSeller", status: "ingame" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };
    });

    await page.locator(".item-card").first().click();
    await expect(page.locator("[data-orderbook-panel]")).toBeVisible({ timeout: 30_000 });

    const bulkPrice = page.locator("[data-orderbook-unit-plat='16.17']");
    await expect(bulkPrice).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator("[data-orderbook-per-trade='6']")).toBeVisible();
    await expect(page.locator("[data-orderbook-best-buy]")).toHaveAttribute(
      "data-orderbook-best-buy",
      "16.17",
    );
    await expect(page.locator("[data-orderbook-spread]")).toHaveAttribute(
      "data-orderbook-spread",
      "13.83",
    );
  });
});
