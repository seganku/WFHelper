import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findMainWindow } from "../../e2e/mainWindow";

// The harness itself cannot be imported here: tsconfig.tests.json has no DOM lib.
const harnessSource = fs.readFileSync(
  path.join(process.cwd(), "e2e/electronTestHarness.ts"),
  "utf8",
);

const OVERLAY = "file:///D:/app/renderer/overlay.html";
const MAIN = "file:///D:/app/renderer/dist/index.html";

function fakeApp(urls: string[]): { windows: () => Array<{ url: () => string }> } {
  return { windows: () => urls.map((url) => ({ url: () => url })) };
}

describe("findMainWindow", () => {
  it("skips the planner overlay when it attached first", () => {
    expect(findMainWindow(fakeApp([OVERLAY, MAIN]))?.url()).toBe(MAIN);
  });

  it("finds the main window whatever the order", () => {
    expect(findMainWindow(fakeApp([MAIN, OVERLAY]))?.url()).toBe(MAIN);
  });

  it("returns null while only overlays are open", () => {
    expect(findMainWindow(fakeApp([OVERLAY, "about:blank"]))).toBeNull();
  });
});

describe("setWindowSize", () => {
  const body =
    harnessSource.match(/export async function setWindowSize\([\s\S]*?\n\}\n/)?.[0] ?? "";

  it("checks the css size the window zoom produces, not the requested one", () => {
    // setContentSize takes device-independent px while innerWidth is CSS px, so
    // a display-derived zoom of 1.3 fails every resize when compared directly.
    expect(body).toContain("getZoomFactor()");
    expect(body).toMatch(/expected = \{ width: width \/ zoom, height: height \/ zoom \}/);
    expect(body).not.toMatch(/landed\.(width|height) - (width|height)\)/);
  });

  it("still fails a resize that did not happen", () => {
    expect(body).toMatch(/landed\.width - expected\.width\) > 2/);
    expect(body).toMatch(/landed\.height - expected\.height\) > 2/);
    expect(body).toContain("throw new Error(");
  });
});
