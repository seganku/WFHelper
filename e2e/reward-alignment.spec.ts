import { test, expect } from "@playwright/test";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  overlayWindow,
  type ElectronTestHarness,
} from "./electronTestHarness";

test("mixed rewards align prices and keep equal part cells at logical sizes and zooms", async () => {
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-reward-alignment-");
    const items = [3, 0, 4, 6].map((count, index) => ({
      name: [
        "Long Prime Neuroptics Component Blueprint",
        "Forma Blueprint",
        "Lex Prime Barrel",
        "Paris Prime String",
      ][index],
      rarity: "rare",
      ducats: count ? 100 : 0,
      setParts: Array.from({ length: count }, (_, part) => ({
        name: `Part ${part + 1}`,
        ownedCount: [1, 20, 1000, 999999, 0, 5][part],
        requiredCount: (part % 2) + 1,
        isReward: part === count - 1,
      })),
    }));
    await evaluateInMain(
      harness.app,
      ({ app }, payload) => {
        const load = process
          .getBuiltinModule("module")
          .createRequire(`${app.getAppPath()}/.electron-build/main.js`);
        const controller = load("./ipc/rewardOverlayIpc.js").rewardWindowsController;
        controller.createOverlayWindow();
        controller.sendOverlayEvent("relic-reward-items", payload);
      },
      items,
    );
    const overlay = await overlayWindow(harness, "overlay.html", "mode=planner");
    await expect(overlay.locator(".reward-slot.has-item")).toHaveCount(4);
    await overlay.evaluate(() => document.fonts.ready);
    await expect
      .poll(() =>
        overlay
          .locator("#slots-grid")
          .evaluate((element) => element.scrollHeight - element.clientHeight),
      )
      .toBeLessThanOrEqual(1);
    for (const logicalWidth of [980, 1029]) {
      for (const zoom of [1, 1.05, 1.3]) {
        await evaluateInMain(
          harness.app,
          ({ app, screen }, size) => {
            const load = process
              .getBuiltinModule("module")
              .createRequire(`${app.getAppPath()}/.electron-build/main.js`);
            const ctx = (load("./ipc/context.js") as typeof import("../ipc/context")).default;
            const { baseZoomForDisplay } = load(
              "./config/runtime/uiScale.js",
            ) as typeof import("../config/runtime/uiScale");
            const display = screen.getPrimaryDisplay();
            ctx.overlaySettings = {
              ...ctx.overlaySettings,
              overlayWindowBounds: {
                ...ctx.overlaySettings.overlayWindowBounds,
                reward: {
                  x: 0,
                  y: 0,
                  displayId: String(display.id),
                  width: size.logicalWidth,
                  height: 360,
                },
              },
              overlayWindowScales: {
                ...ctx.overlaySettings.overlayWindowScales,
                reward: size.zoom / baseZoomForDisplay(display.workArea),
              },
            };
            (
              load("./ipc/rewardOverlayIpc.js") as typeof import("../ipc/rewardOverlayIpc")
            ).rewardWindowsController.positionOverlayWindow();
          },
          { logicalWidth, zoom },
        );
        await expect.poll(() => overlay.evaluate(() => window.innerWidth)).toBe(logicalWidth);
        await expect
          .poll(async () =>
            overlay.locator(".reward-slot").evaluateAll((cards) => {
              const tops = cards.map(
                (card) => card.querySelector(".slot-price-row")!.getBoundingClientRect().top,
              );
              return Math.max(...tops) - Math.min(...tops);
            }),
          )
          .toBeLessThanOrEqual(0.1);
        const where = `width ${logicalWidth}, zoom ${zoom}`;
        // The chip widths and the one-line name fit are applied from a
        // requestAnimationFrame the window resize schedules, so they land after
        // innerWidth already reports the new size.
        await expect(async () => {
          const widths = await overlay
            .locator(".slot-set-part")
            .evaluateAll((chips) => chips.map((chip) => chip.getBoundingClientRect().width));
          expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(0.1);
          const rows = await overlay
            .locator(".slot-set-parts")
            .last()
            .locator(".slot-set-part")
            .evaluateAll((chips) => chips.map((chip) => chip.getBoundingClientRect().top));
          expect(rows[0]).toBe(rows[2]);
          expect(rows[3]).toBe(rows[5]);
          expect(rows[3]).toBeGreaterThan(rows[0]);
          const names = await overlay.locator(".slot-name").evaluateAll((elements) =>
            elements.map((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              const styles = getComputedStyle(element);
              return {
                lines: new Set(Array.from(range.getClientRects(), (rect) => rect.top)).size,
                height: element.getBoundingClientRect().height,
                configured: Number.parseFloat(styles.getPropertyValue("--slot-name-size")),
                fontSize: Number.parseFloat(styles.fontSize),
                overflow: element.scrollWidth - element.clientWidth,
              };
            }),
          );
          const [overlong, ...fitting] = names;
          expect(overlong.lines, `overlong name at ${where}`).toBe(1);
          expect(overlong.fontSize).toBeLessThan(overlong.configured);
          expect(overlong.fontSize).toBeGreaterThanOrEqual(overlong.configured * 0.75);
          for (const name of names) {
            expect(name.overflow, `clipped name at ${where}`).toBe(0);
            expect(name.height).toBeCloseTo(name.configured * 2.5, 1);
          }
          for (const name of fitting)
            expect(name.fontSize, `unshrunk name at ${where}`).toBe(name.configured);
        }).toPass({ timeout: 15_000 });
        const largeCount = overlay
          .locator(".slot-set-part-count")
          .filter({ hasText: "999999" })
          .first();
        await expect(largeCount.locator("..")).toHaveAttribute("title", /999999/);
        expect(
          await largeCount.evaluate((element) => ({
            bounded: element.clientWidth <= element.parentElement!.clientWidth,
            ellipsis: getComputedStyle(element).textOverflow,
          })),
        ).toEqual({ bounded: true, ellipsis: "ellipsis" });
      }
    }
    await overlay.screenshot({ path: test.info().outputPath("mixed-reward-alignment.png") });
  } finally {
    await closeElectronTestHarness(harness);
  }
});
