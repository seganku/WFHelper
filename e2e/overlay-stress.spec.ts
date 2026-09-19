import fs from "node:fs";
import path from "node:path";

import { test, expect, type ElectronApplication, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  overlayWindow,
  type ElectronTestHarness,
} from "./electronTestHarness";

const ITERATIONS = readCount("WFHELPER_OVERLAY_STRESS_ITERATIONS", 300);
const TRIGGER_ITERATIONS = readCount("WFHELPER_OVERLAY_STRESS_TRIGGER_ITERATIONS", 60);
const SETTLE_MS = 150;
const TRIGGER_GAP_MS = 200;
// One window per overlay controller plus slack is all a healthy churn ever adds
// to the launch count.
const WINDOW_HEADROOM = 6;
const MAIN_LOG_TAIL_LINES = 40;
const SAMPLE_EVERY = 25;
const INTERACTIVE_EVERY = 10;

// A dead main process reaches the test as a closed Playwright target, never as
// an error naming the crash. These wordings all mean "the app is gone".
const TARGET_GONE =
  /Target closed|has been closed|Target page, context or browser has been closed|Execution context was destroyed/i;

type OverlayControllerHandle = {
  createOverlayWindow: (options?: { show?: boolean }) => void;
  hideOverlayWindow: () => void;
  setOverlayInteractiveMode: (enabled: boolean) => void;
  isOverlayWindowVisible: () => boolean;
};

type OverlayWindowRef = {
  isDestroyed: () => boolean;
  isFocusable: () => boolean;
  isFocused: () => boolean;
  webContents: { id: number };
} | null;
type ChurnTarget = "reward" | "planner" | "riven" | "arbiSummary";
type ChurnAction = "show" | "hide" | "interactive" | "passive";
type OverlayBridgeWindow = Window & { overlay: { close: () => void } };

function readCount(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mainLogPath(harness: ElectronTestHarness): string {
  return path.join(harness.sandboxDir, "user-data", "logs", "main.log");
}

function mainLogTail(harness: ElectronTestHarness): string {
  try {
    const lines = fs.readFileSync(mainLogPath(harness), "utf8").split(/\r?\n/);
    return lines.slice(-MAIN_LOG_TAIL_LINES).join("\n");
  } catch (error) {
    return `main.log unreadable: ${String(error)}`;
  }
}

function crashDumps(harness: ElectronTestHarness): string[] {
  const dir = path.join(harness.sandboxDir, "user-data", "Crashpad", "reports");
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".dmp"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** Closing the harness deletes the sandbox, so a crash's evidence is copied out first. */
function saveArtifacts(harness: ElectronTestHarness): string | null {
  const root = process.env.WFHELPER_OVERLAY_STRESS_ARTIFACTS;
  if (!root) return null;
  const dir = path.join(root, `run-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(mainLogPath(harness), path.join(dir, "main.log"));
  } catch (error) {
    console.log(`[stress] main.log copy failed: ${String(error)}`);
  }
  for (const dump of crashDumps(harness)) {
    try {
      fs.copyFileSync(dump, path.join(dir, path.basename(dump)));
    } catch (error) {
      console.log(`[stress] dump copy failed: ${String(error)}`);
    }
  }
  return dir;
}

function sampleMain(app: ElectronApplication): Promise<{ windows: number; rss: number }> {
  return evaluateInMain(app, ({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().length,
    rss: process.memoryUsage().rss,
  }));
}

function mib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MiB`;
}

/** The id comes from the shared context because a just-created window reports no URL yet. */
function churn(
  app: ElectronApplication,
  target: ChurnTarget,
  action: ChurnAction,
): Promise<{ visible: boolean; ids: number[]; focusable: boolean; focused: boolean }> {
  return evaluateInMain(
    app,
    ({ app: electronApp }, options) => {
      const mainModule = process.mainModule as unknown as {
        require: (id: string) => unknown;
      };
      const buildDir = `${electronApp.getAppPath()}/.electron-build`;
      const overlayIpc = mainModule.require(`${buildDir}/ipc/rewardOverlayIpc`) as Record<
        string,
        OverlayControllerHandle
      >;
      const context = mainModule.require(`${buildDir}/ipc/context`) as {
        default: Record<string, OverlayWindowRef>;
      };
      let visible: boolean;
      let windows: OverlayWindowRef[];
      if (options.target === "riven") {
        const riven = mainModule.require(`${buildDir}/ipc/rivenOverlayIpc`) as {
          onRivenSessionOpen: () => void;
          onRivenSessionClose: () => void;
          setRivenInteractiveMode: (enabled: boolean) => void;
          isAnyRivenWindowVisible: () => boolean;
        };
        if (options.action === "show") riven.onRivenSessionOpen();
        else if (options.action === "hide") riven.onRivenSessionClose();
        else riven.setRivenInteractiveMode(options.action === "interactive");
        visible = riven.isAnyRivenWindowVisible();
        windows = [context.default.rivenOverlayLeftWindow, context.default.rivenOverlayRightWindow];
      } else {
        const arbi =
          options.target === "arbiSummary"
            ? (mainModule.require(`${buildDir}/ipc/arbiOverlayIpc`) as {
                arbiSummaryWindowsController: OverlayControllerHandle;
              })
            : null;
        const controller =
          arbi?.arbiSummaryWindowsController ??
          (options.target === "reward"
            ? overlayIpc.rewardWindowsController
            : overlayIpc.plannerWindowsController);
        if (options.action === "show") controller.createOverlayWindow();
        else if (options.action === "hide") controller.hideOverlayWindow();
        else controller.setOverlayInteractiveMode(options.action === "interactive");
        visible = controller.isOverlayWindowVisible();
        const key =
          options.target === "reward"
            ? "overlayWindow"
            : options.target === "planner"
              ? "plannerOverlayWindow"
              : "arbiSummaryWindow";
        windows = [context.default[key]];
      }
      const live = windows.filter(
        (window): window is NonNullable<OverlayWindowRef> => !!window && !window.isDestroyed(),
      );
      return {
        visible,
        ids: live.map((window) => window.webContents.id),
        focusable: live.some((window) => window.isFocusable()),
        // Reported for the failure dump only. Handing focus back belongs to the
        // interaction hotkey (captureWarframeFocus/restoreWarframeFocus, covered by
        // warframeFocus.test.ts), not the controller this loop drives; a keep-mapped
        // window stays mapped, so Windows never reassigns focus on its own.
        focused: live.some((window) => window.isFocused()),
      };
    },
    { target, action },
  );
}

test("overlay show/hide churn keeps the main process alive", async () => {
  test.skip(
    !process.env.WFHELPER_OVERLAY_STRESS,
    "stress loop; set WFHELPER_OVERLAY_STRESS=1 (pnpm run test:overlay-stress)",
  );
  test.setTimeout(30 * 60_000);

  let harness: ElectronTestHarness | undefined;
  const mainExit: { info: string | null } = { info: null };
  let phase = "launch";
  let iteration = 0;

  async function step<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (mainExit.info || TARGET_GONE.test(String(error))) {
        throw new Error(
          `main process gone in phase=${phase} iteration=${iteration}; ` +
            `exit ${mainExit.info ?? "not reported"}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** The newest live reward page: a rebuilt window leaves an older entry in the
   *  window list that can already be a closed target. */
  async function rewardOverlayPage(live: ElectronTestHarness): Promise<Page> {
    await overlayWindow(live, "overlay.html", "mode=planner");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pages = live.app
        .windows()
        .filter(
          (win) =>
            win.url().includes("overlay.html") &&
            !win.url().includes("mode=planner") &&
            !win.isClosed(),
        );
      const page = pages[pages.length - 1];
      if (page) return page;
      await wait(100);
    }
    throw new Error("no live reward overlay page");
  }

  async function closeRewardOverlay(live: ElectronTestHarness): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const page = await rewardOverlayPage(live);
      try {
        await page.evaluate(() => (window as unknown as OverlayBridgeWindow).overlay.close());
        return;
      } catch (error) {
        // A window torn down between the lookup and the call is ordinary churn;
        // only a dead main process may fail the run.
        if (mainExit.info || !TARGET_GONE.test(String(error))) throw error;
        await wait(150);
      }
    }
    throw new Error("reward overlay never accepted overlay.close()");
  }

  try {
    const live = await launchElectronTestHarness("wfh-overlay-stress-");
    harness = live;
    live.app.process().once("exit", (code, signal) => {
      mainExit.info = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    });

    const requireVia = await step(() =>
      evaluateInMain(live.app, ({ app: electronApp }) => {
        const modulePath = `${electronApp.getAppPath()}/.electron-build/ipc/rewardOverlayIpc`;
        const viaMain = process.mainModule as unknown as {
          require?: (id: string) => unknown;
        } | null;
        if (viaMain && typeof viaMain.require === "function") {
          try {
            viaMain.require(modulePath);
            return "process.mainModule.require";
          } catch {
            // The createRequire path below gets a turn.
          }
        }
        const viaGlobal = globalThis as typeof globalThis & {
          require?: (id: string) => unknown;
        };
        if (typeof viaGlobal.require === "function") {
          try {
            const nodeModule = viaGlobal.require("module") as {
              createRequire: (from: string) => (id: string) => unknown;
            };
            nodeModule.createRequire(`${electronApp.getAppPath()}/.electron-build/main.js`)(
              modulePath,
            );
            return "module.createRequire";
          } catch {
            // Reported as "none" below.
          }
        }
        return "none";
      }),
    );
    console.log(`[stress] main-process module access via ${requireVia}`);
    expect(requireVia).not.toBe("none");

    await step(() =>
      evaluateInMain(live.app, ({ app: electronApp }) => {
        const mainModule = process.mainModule as unknown as { require: (id: string) => unknown };
        const scan = mainModule.require(
          `${electronApp.getAppPath()}/.electron-build/ipc/overlay/rivenScan`,
        ) as {
          scanInitialCard: () => Promise<unknown>;
        };
        scan.scanInitialCard = async () => ({
          stats: [],
          rawText: "",
          titleText: "",
          footerText: "",
          capture: null,
          lowConfidence: false,
        });
      }),
    );

    const baseline = await step(() => sampleMain(live.app));
    console.log(
      `[stress] baseline windows=${baseline.windows} rss=${mib(baseline.rss)}; ` +
        `trigger=${TRIGGER_ITERATIONS} churn=${ITERATIONS}`,
    );

    phase = "trigger";
    for (iteration = 1; iteration <= TRIGGER_ITERATIONS; iteration += 1) {
      await step(() => live.page.evaluate(() => window.api.simulateRelicTrigger()));
      await step(() => closeRewardOverlay(live));
      await wait(TRIGGER_GAP_MS);
      if (iteration % SAMPLE_EVERY === 0) {
        const now = await step(() => sampleMain(live.app));
        console.log(
          `[stress] trigger ${iteration}/${TRIGGER_ITERATIONS} windows=${now.windows} rss=${mib(now.rss)}`,
        );
        expect(now.windows).toBeLessThanOrEqual(baseline.windows + WINDOW_HEADROOM);
      }
    }

    phase = "churn";
    const builtIds: Record<ChurnTarget, Set<number>> = {
      reward: new Set(),
      planner: new Set(),
      riven: new Set(),
      arbiSummary: new Set(),
    };
    for (iteration = 1; iteration <= ITERATIONS; iteration += 1) {
      for (const target of ["reward", "planner", "riven", "arbiSummary"] as const) {
        const shown = await step(() => churn(live.app, target, "show"));
        expect(shown.visible).toBe(true);
        expect(shown.ids).toHaveLength(target === "riven" ? 2 : 1);
        for (const id of shown.ids) builtIds[target].add(id);
        await wait(SETTLE_MS);
        if (iteration % INTERACTIVE_EVERY === 0) {
          await step(() => churn(live.app, target, "interactive"));
          await step(() => churn(live.app, target, "passive"));
        }
        const hidden = await step(() => churn(live.app, target, "hide"));
        expect(hidden.visible).toBe(false);
        expect(hidden.focusable).toBe(false);
        if (iteration % INTERACTIVE_EVERY === 0) {
          const requested = await step(() => churn(live.app, target, "interactive"));
          expect(requested.visible).toBe(false);
          expect(requested.focusable).toBe(false);
          await step(() => churn(live.app, target, "passive"));
        }
        await wait(SETTLE_MS);
      }
      if (iteration % SAMPLE_EVERY === 0) {
        const now = await step(() => sampleMain(live.app));
        console.log(
          `[stress] churn ${iteration}/${ITERATIONS} windows=${now.windows} rss=${mib(now.rss)}`,
        );
        expect(now.windows).toBeLessThanOrEqual(baseline.windows + WINDOW_HEADROOM);
      }
    }

    phase = "done";
    const end = await step(() => sampleMain(live.app));
    console.log(
      `[stress] survived; windows ${baseline.windows} -> ${end.windows}, ` +
        `rss ${mib(baseline.rss)} -> ${mib(end.rss)}, ` +
        `distinct reward windows=${builtIds.reward.size} planner=${builtIds.planner.size} ` +
        `riven=${builtIds.riven.size} arbi=${builtIds.arbiSummary.size}`,
    );
    if (process.platform === "win32") {
      for (const target of ["reward", "planner", "riven", "arbiSummary"] as const) {
        expect(builtIds[target].size, `${target} rebuilt during keep-mapped churn`).toBe(
          target === "riven" ? 2 : 1,
        );
      }
    }
    expect(mainExit.info).toBeNull();
  } catch (error) {
    if (harness) {
      console.log(
        `[stress] FAILED phase=${phase} iteration=${iteration} exit=${mainExit.info ?? "none"}`,
      );
      const saved = saveArtifacts(harness);
      if (saved) console.log(`[stress] artifacts copied to ${saved}`);
      console.log(`[stress] crashpad dumps: ${crashDumps(harness).join(", ") || "none"}`);
      console.log(`[stress] main.log tail:\n${mainLogTail(harness)}`);
    }
    throw error;
  } finally {
    await closeElectronTestHarness(harness);
  }
});
