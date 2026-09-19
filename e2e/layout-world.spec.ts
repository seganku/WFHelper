import { expect, test, type Page } from "@playwright/test";

import type { ArbiSchedulePayload } from "../config/shared/arbiScheduleTypes";
import { ARBI_SCHED_GET, DB_GET_WORLD_STATE } from "../config/shared/ipcChannels";
import type { WorldState } from "../src/types/world";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  LAYOUT_SCALES,
  LAYOUT_SIZES,
  openView,
  setFontScale,
  setWindowSize,
  type ElectronTestHarness,
} from "./electronTestHarness";

const LONGEST_FACTION = "Corrupted";
// Grid order in ArbiSchedule.svelte: time, node, mission, faction, starts in.
const FACTION_COLUMN = 3;

const ARBI_NODES = [
  { id: "SolNode001", node: "Kala-azar (Eris)", mission: "Defense", faction: "Infested" },
  { id: "SolNode002", node: "Malva (Venus)", mission: "Survival", faction: "Corpus" },
  { id: "SolNode003", node: "Apollodorus (Mercury)", mission: "Survival", faction: "Infested" },
  { id: "SolNode004", node: "Everest (Earth)", mission: "Excavation", faction: "Grineer" },
  { id: "SolNode005", node: "Stofler (Lua)", mission: "Defense", faction: "Corrupted" },
  { id: "SolNode006", node: "Zeugma (Phobos)", mission: "Survival", faction: "Corpus" },
  { id: "SolNode007", node: "Alator (Mars)", mission: "Interception", faction: "Grineer" },
  { id: "SolNode008", node: "Akkad (Eris)", mission: "Defense", faction: "Infested" },
  { id: "SolNode009", node: "Casta (Ceres)", mission: "Defense", faction: "Grineer" },
  { id: "SolNode010", node: "Cinxia (Ceres)", mission: "Interception", faction: "Grineer" },
  { id: "SolNode011", node: "Helene (Saturn)", mission: "Defense", faction: "Grineer" },
  { id: "SolNode012", node: "Ose (Europa)", mission: "Interception", faction: "Corpus" },
];

// One pixel of transparent GIF: enough for a row that really has a thumbnail.
const PIXEL_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const BARO_WITH_ART = "/Lotus/Types/Items/MiscItems/LayoutFixtureArt";
const BARO_WITHOUT_ART = "/Lotus/Types/Items/MiscItems/LayoutFixtureNoArt";

function buildSchedule(now: number): ArbiSchedulePayload {
  const entries = ARBI_NODES.flatMap((node, index) =>
    [0, 1, 2].map((slot) => ({
      epochMs: now + (index + slot * ARBI_NODES.length) * 3_600_000,
      nodeId: node.id,
      node: node.node,
      mission: node.mission,
      faction: node.faction,
    })),
  );
  return {
    entries,
    fetchedAt: now - 60_000,
    alerts: { occurrences: [], favoriteNodes: [], minutesBefore: 5 },
  };
}

function buildWorld(now: number): WorldState {
  const expiry = new Date(now + 4 * 86_400_000).toISOString();
  return {
    archonHunt: {
      id: "layout-archon",
      boss: "Archon Boreal",
      activation: new Date(now - 86_400_000).toISOString(),
      expiry,
      missions: [],
    },
    duviriCycle: {
      expiry,
      choices: [
        { category: "normal", choices: ["Excalibur", "Trinity", "Ember"] },
        { category: "hard", choices: ["Braton", "Lato", "Skana", "Paris", "Kunai"] },
      ],
    },
    steelPath: {
      currentReward: { name: "Umbra Forma", cost: 150 },
      expiry,
      rotation: [],
      evergreens: [],
    },
    voidTrader: {
      activation: new Date(now - 86_400_000).toISOString(),
      expiry,
      location: "Kronia Relay (Saturn)",
      inventory: [
        {
          uniqueName: BARO_WITH_ART,
          item: "Fixture Relay Banner",
          ducats: 100,
          credits: 50_000,
          imageOverride: PIXEL_GIF,
        },
        {
          uniqueName: BARO_WITHOUT_ART,
          item: "Fixture Relay Sigil",
          ducats: 200,
          credits: 75_000,
        },
      ],
    },
  };
}

async function openWorldTab(page: Page, tab: string): Promise<void> {
  await openView(page, "world");
  await page.locator(`#content [data-tour-tab="${tab}"]`).click();
  await page.waitForTimeout(300);
}

function measureArbiTable(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-arbi-table]");
    const head = document.querySelector<HTMLElement>("[data-arbi-head]");
    const row = document.querySelector<HTMLElement>("[data-arbi-row]");
    if (!scroller || !head || !row) throw new Error("arbitration table is missing");

    // Measure the text run, not the box: range rects ignore the ellipsis clip.
    let spill = 0;
    for (const cell of Array.from(head.children)) {
      if (!cell.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(cell);
      const text = range.getBoundingClientRect();
      const box = cell.getBoundingClientRect();
      spill = Math.max(spill, text.right - box.right, box.left - text.left);
    }

    const split = document.querySelector<HTMLElement>("[data-tour='arbi-schedule']");
    const aside = document.querySelector<HTMLElement>("[data-tour='arbi-filters']");
    if (!split || !aside) throw new Error("arbitration split is missing");
    const tracks = getComputedStyle(split).gridTemplateColumns.split(/\s+/);

    // The probe lives inside the cell, so 6ch resolves against that cell's font.
    const cell = (name: string) => {
      const element = row.querySelector<HTMLElement>(`[data-arbi-cell="${name}"]`);
      if (!element) throw new Error(`${name} cell is missing`);
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;width:6ch;";
      element.appendChild(probe);
      const sixCh = probe.getBoundingClientRect().width;
      probe.remove();
      return { width: element.clientWidth, sixCh };
    };

    return {
      spill,
      node: cell("node"),
      mission: cell("mission"),
      overflow: scroller.scrollWidth - scroller.clientWidth,
      columns: tracks.filter((track) => track.endsWith("px")).length,
      asideHeight: parseFloat(aside.style.height) || 0,
    };
  });
}

function measureFactionCells(page: Page, column: number) {
  return page.evaluate((index) => {
    const scroller = document.querySelector<HTMLElement>("[data-arbi-table]");
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-arbi-row]"));
    if (!scroller || rows.length === 0) throw new Error("arbitration rows are missing");
    const cells = rows.map((row) => {
      const cell = row.children[index];
      if (!(cell instanceof HTMLElement)) throw new Error("faction cell is missing");
      const range = document.createRange();
      range.selectNodeContents(cell);
      const text = range.getBoundingClientRect();
      const box = cell.getBoundingClientRect();
      return {
        faction: cell.textContent?.trim() ?? "",
        spill: Math.max(text.right - box.right, box.left - text.left),
        hidden: cell.scrollWidth - cell.clientWidth,
      };
    });
    return {
      factions: Array.from(new Set(cells.map((cell) => cell.faction))),
      spill: Math.max(...cells.map((cell) => cell.spill)),
      hidden: Math.max(...cells.map((cell) => cell.hidden)),
      overflow: scroller.scrollWidth - scroller.clientWidth,
    };
  }, column);
}

function countNodeRows(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>("[data-arbi-node-list]");
    if (!list) throw new Error("node list is missing");
    const box = list.getBoundingClientRect();
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-arbi-node]"));
    return {
      total: rows.length,
      visible: rows.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5;
      }).length,
    };
  });
}

function measureWeekCards(page: Page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-world-week-task]")).map(
      (card) => {
        const content = card.firstElementChild;
        if (!content) throw new Error("a week card has no content");
        const cardBox = card.getBoundingClientRect();
        const contentBox = content.getBoundingClientRect();
        return { top: cardBox.top, rowTop: Math.round(cardBox.top), contentTop: contentBox.top };
      },
    );
    if (cards.length === 0) throw new Error("the week strip has no cards");
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    // Cards wrap into rows on a narrow window, so a row is the unit that has to line up.
    const rows = new Map<number, number[]>();
    for (const card of cards)
      rows.set(card.rowTop, [...(rows.get(card.rowTop) ?? []), card.contentTop]);
    return {
      count: cards.length,
      offsetSpread: spread(cards.map((card) => card.contentTop - card.top)),
      rowSpread: Math.max(...Array.from(rows.values(), spread)),
    };
  });
}

test.describe("World layout holds at a raised text scale", () => {
  test.setTimeout(600_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    const now = Date.now();
    harness = await launchElectronTestHarness("wfh-layout-world-", {
      inventory: { Suits: [] },
      storage: { "world-tab": "world" },
    });
    page = harness.page;
    await evaluateInMain(
      harness.app,
      ({ ipcMain }, fixture) => {
        ipcMain.removeHandler(fixture.worldChannel);
        ipcMain.handle(fixture.worldChannel, () => fixture.world);
        ipcMain.removeHandler(fixture.arbiChannel);
        ipcMain.handle(fixture.arbiChannel, () => fixture.schedule);
      },
      {
        worldChannel: DB_GET_WORLD_STATE,
        arbiChannel: ARBI_SCHED_GET,
        world: buildWorld(now),
        schedule: buildSchedule(now),
      },
    );
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("the arbitration table keeps every column readable", async () => {
    const cases = [
      ...LAYOUT_SIZES.flatMap((size) =>
        LAYOUT_SCALES.map((scale) => ({ ...size, scale, columns: 1 })),
      ),
      { width: 1920, height: 1040, scale: 1, columns: 2 },
      { width: 1920, height: 1040, scale: 1.25, columns: 2 },
    ];
    for (const item of cases) {
      await setFontScale(page, item.scale);
      await setWindowSize(harness, item.width, item.height);
      await openWorldTab(page, "arbis");
      await expect(page.locator("[data-arbi-table]")).toBeVisible({ timeout: 30_000 });

      const table = await measureArbiTable(page);
      const where = `${item.width}x${item.height}, ${item.scale}x`;
      await page
        .locator("[data-arbi-table]")
        .screenshot({ path: test.info().outputPath(`arbi-table-${item.width}-${item.scale}.png`) });

      expect(table.columns, `split columns at ${where}`).toBe(item.columns);
      expect(table.spill, `a header paints past its cell at ${where}`).toBeLessThanOrEqual(0.5);
      expect(table.node.width, `node column below 6ch at ${where}`).toBeGreaterThanOrEqual(
        table.node.sixCh,
      );
      expect(table.mission.width, `mission column below 6ch at ${where}`).toBeGreaterThanOrEqual(
        table.mission.sixCh,
      );
      expect(table.overflow, `the table scrolls sideways at ${where}`).toBeLessThanOrEqual(0.5);
      if (item.columns === 2)
        expect(table.asideHeight, `sidebar height unset at ${where}`).toBeGreaterThanOrEqual(280);
      else expect(table.asideHeight, `sidebar height pinned at ${where}`).toBe(0);
    }
  });

  test("the faction column holds its longest name at 1.5x", async () => {
    await setFontScale(page, 1.5);
    for (const size of LAYOUT_SIZES) {
      await setWindowSize(harness, size.width, size.height);
      await openWorldTab(page, "arbis");
      await expect(page.locator("[data-arbi-table]")).toBeVisible({ timeout: 30_000 });

      const faction = await measureFactionCells(page, FACTION_COLUMN);
      const where = `${size.width}x${size.height}, 1.5x`;
      await page
        .locator("[data-arbi-table]")
        .screenshot({ path: test.info().outputPath(`arbi-faction-${size.width}-1.5.png`) });

      expect(
        faction.factions,
        `the fixture seeded no ${LONGEST_FACTION} row at ${where}`,
      ).toContain(LONGEST_FACTION);
      expect(faction.spill, `a faction paints past its cell at ${where}`).toBeLessThanOrEqual(0.5);
      expect(faction.hidden, `a faction cell clips its own text at ${where}`).toBeLessThanOrEqual(
        1,
      );
      expect(faction.overflow, `the table scrolls sideways at ${where}`).toBeLessThanOrEqual(0.5);
    }
  });

  test("the node list keeps at least four rows in view", async () => {
    for (const size of LAYOUT_SIZES) {
      for (const scale of LAYOUT_SCALES) {
        await setFontScale(page, scale);
        await setWindowSize(harness, size.width, size.height);
        await openWorldTab(page, "arbis");
        await expect(page.locator("[data-arbi-node-list]")).toBeVisible({ timeout: 30_000 });

        const rows = await countNodeRows(page);
        const where = `${size.width}x${size.height}, ${scale}x`;
        await page
          .locator('[data-tour="arbi-filters"]')
          .screenshot({ path: test.info().outputPath(`arbi-nodes-${size.width}-${scale}.png`) });

        expect(rows.total, `the schedule fixture seeded no nodes at ${where}`).toBe(
          ARBI_NODES.length,
        );
        expect(
          rows.visible,
          `node list shows ${rows.visible} rows at ${where}`,
        ).toBeGreaterThanOrEqual(4);
      }
    }
  });

  test("the Baro pill keeps a space before the relay name", async () => {
    await setFontScale(page, 1);
    await setWindowSize(harness, 1366, 728);
    await openWorldTab(page, "world");
    const pill = page.locator("[data-world-baro-pill]");
    await expect(pill).toBeVisible({ timeout: 30_000 });
    expect(await pill.textContent()).toMatch(/\S - \S/);
  });

  test("the week cards start their content at the same height", async () => {
    for (const size of LAYOUT_SIZES) {
      for (const scale of [1, ...LAYOUT_SCALES]) {
        await setFontScale(page, scale);
        await setWindowSize(harness, size.width, size.height);
        await openWorldTab(page, "world");
        await expect(page.locator("[data-world-week-overview]")).toBeVisible({ timeout: 30_000 });

        const cards = await measureWeekCards(page);
        const where = `${size.width}x${size.height}, ${scale}x`;
        await page
          .locator("[data-world-week-overview]")
          .screenshot({ path: test.info().outputPath(`week-cards-${size.width}-${scale}.png`) });

        expect(cards.count, `no week cards at ${where}`).toBeGreaterThan(1);
        expect(
          cards.offsetSpread,
          `card content starts at different heights at ${where}`,
        ).toBeLessThanOrEqual(2);
        expect(
          cards.rowSpread,
          `cards in one row disagree on their top at ${where}`,
        ).toBeLessThanOrEqual(2);
      }
    }
  });

  test("the Baro planner lines up names with and without a thumbnail", async () => {
    await setFontScale(page, 1);
    await setWindowSize(harness, 1366, 728);
    await openWorldTab(page, "baro");
    await expect(page.locator("[data-baro-planner]")).toBeVisible({ timeout: 30_000 });
    // Recorded history may add rows, so the fixture pair is addressed by name.
    await expect(page.locator(`[data-baro-row="${BARO_WITH_ART}"]`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator(`[data-baro-row="${BARO_WITHOUT_ART}"]`)).toBeVisible();

    const names = await page.evaluate(
      (fixture) => {
        const cells = Array.from(document.querySelectorAll<HTMLElement>("[data-baro-name]"));
        const lefts = cells.map((cell) => cell.getBoundingClientRect().left);
        const row = (uniqueName: string) => {
          const found = document.querySelector<HTMLElement>(`[data-baro-row="${uniqueName}"]`);
          if (!found) throw new Error(`${uniqueName} row is missing`);
          return found;
        };
        return {
          cells: cells.length,
          spread: Math.max(...lefts) - Math.min(...lefts),
          artHasImage: !!row(fixture.withArt).querySelector("img"),
          plainHasImage: !!row(fixture.withoutArt).querySelector("img"),
        };
      },
      { withArt: BARO_WITH_ART, withoutArt: BARO_WITHOUT_ART },
    );
    await page
      .locator("[data-baro-table]")
      .screenshot({ path: test.info().outputPath("baro-item-names.png") });

    expect(names.cells, "the planner listed no item names").toBeGreaterThan(1);
    expect(names.artHasImage, "the fixture row with artwork lost its thumbnail").toBe(true);
    expect(names.plainHasImage, "the fixture row without artwork grew an image").toBe(false);
    expect(names.spread, "item names start at different x").toBeLessThanOrEqual(0.5);
  });
});
