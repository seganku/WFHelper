import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("reports intrinsic reward height without shrinking when a capped grid is scrolled", () => {
  const report = vi.fn();
  const frames: (() => void)[] = [];
  const grid = {
    scrollTop: 0,
    classList: { contains: () => false },
    querySelector: () => ({}),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ bottom: 210 - grid.scrollTop }) }],
    getBoundingClientRect: () => ({ top: 10 }),
  };
  const panel = {};
  const footer = { getBoundingClientRect: () => ({ height: 20 }) };
  const source = readFileSync("renderer/overlay.js", "utf8");
  const measure = runInNewContext(`${source}\nreportRewardContentHeight;`, {
    URLSearchParams,
    window: {
      location: { search: "" },
      overlay: { reportContentHeight: report },
      overlayI18n: { t: vi.fn() },
    },
    document: {
      addEventListener: vi.fn(),
      getElementById: (id: string) =>
        id === "slots-grid" ? grid : id === "panel" ? panel : footer,
    },
    requestAnimationFrame: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
    getComputedStyle: (element: unknown) =>
      element === grid ? { paddingBottom: "4" } : { borderTopWidth: "1", borderBottomWidth: "1" },
  }) as () => void;
  measure();
  frames.shift()?.();
  expect(report).toHaveBeenCalledExactlyOnceWith(226);
  for (const scrollTop of [60, 120, 0]) {
    grid.scrollTop = scrollTop;
    measure();
    frames.shift()?.();
    expect(report).toHaveBeenCalledTimes(1);
  }
});
