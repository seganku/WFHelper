import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

const invoke = vi.hoisted(() =>
  vi.fn(async (channel: string) => (channel === "popoutList" ? [] : {})),
);
vi.mock("../../../src/lib/ipc.js", () => ({ invoke, on: () => () => undefined }));
vi.mock("../../../src/lib/log.js", () => ({ log: { warn: vi.fn() } }));
import {
  applyCustomization,
  CUSTOMIZATION_MAX_BYTES,
  exportCustomization,
  parseCustomization,
} from "../../../src/lib/customization.js";
import { registerSections } from "../../../src/lib/layout/registry.js";
import { customCss } from "../../../src/stores/customCss.js";
import { inventoryViewMode } from "../../../src/stores/inventoryViewMode.js";
import { themeSettings } from "../../../src/stores/theme.js";
import { deleteWorkspace, workspaces } from "../../../src/stores/workspaces.js";

function fixture() {
  const workspace = {
    id: "example",
    name: "Example",
    sidebar: { order: ["world", "settings"], hidden: ["stats"], width: 220 },
    layout: { version: 1, views: {} },
    filterLayout: {},
    popouts: [],
  };
  return {
    kind: "wfhelper-customization",
    version: 1,
    theme: { colors: { accent: "#123456" }, fontSizes: { globalScale: 1.2 } },
    workspace,
    savedWorkspaces: { version: 1, workspaces: [workspace], restoreOnLaunch: null },
    overlays: {
      rewardLayout: { version: 1, fields: { rarity: { hidden: true } } },
      overlayLayouts: {},
      overlayScale: 1.2,
      overlayWindowScales: { planner: 9 },
      hotkey: "F1",
      notificationSoundEnabled: false,
      inventoryPath: "private",
    },
    customCss: ".card { color: red; }",
    inventoryViewMode: "list",
  };
}

beforeEach(() => {
  invoke.mockClear();
  for (const workspace of get(workspaces).workspaces) deleteWorkspace(workspace.id);
});

describe("portable customization", () => {
  it("rejects excessive popout counts before applying settings", () => {
    const raw = fixture();
    expect(() =>
      parseCustomization(
        JSON.stringify({
          ...raw,
          workspace: {
            ...raw.workspace,
            popouts: Array.from({ length: 129 }, (_, i) => ({
              target: { kind: "section", sectionId: `world.section${i}` },
            })),
          },
        }),
      ),
    ).toThrow("invalid-file");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("bounds imported branding and themes and preserves display association", () => {
    for (const theme of [
      { branding: { appName: "x".repeat(81) } },
      { branding: { logoDataUrl: "x".repeat(512 * 1024 + 1) } },
      { customThemes: Array.from({ length: 101 }, () => ({})) },
    ])
      expect(() => parseCustomization(JSON.stringify({ ...fixture(), theme }))).toThrow(
        "invalid-file",
      );
    const raw = fixture();
    const parsed = parseCustomization(
      JSON.stringify({
        ...raw,
        overlays: {
          ...raw.overlays,
          overlayWindowBounds: { reward: { x: 200, y: 300, displayId: "screen-2" } },
        },
      }),
    );
    expect(parsed.overlays.overlayWindowBounds.reward).toEqual({
      x: 200,
      y: 300,
      displayId: "screen-2",
    });
  });
  it("rejects unrelated, malformed, newer and oversized files before mutation", async () => {
    for (const value of [
      {},
      { ...fixture(), version: 2 },
      { ...fixture(), workspace: {} },
      { ...fixture(), theme: [] },
      { ...fixture(), overlays: { rewardLayout: { version: 2, fields: {} } } },
      { ...fixture(), savedWorkspaces: { version: 1, workspaces: [{}] } },
    ]) {
      expect(() => parseCustomization(JSON.stringify(value))).toThrow();
    }
    expect(() => parseCustomization(" ".repeat(CUSTOMIZATION_MAX_BYTES + 1))).toThrow("too-large");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("drops unrelated settings, unsafe fields and prototype keys while normalizing appearance", () => {
    const raw = fixture();
    const parsed = parseCustomization(JSON.stringify(raw));
    expect(parsed.overlays).not.toHaveProperty("hotkey");
    expect(parsed.overlays).not.toHaveProperty("inventoryPath");
    expect(parsed.overlays).not.toHaveProperty("overlayScale");
    expect(parsed.overlays.overlayWindowScales.reward).toBe(1.2);
    expect(parsed.overlays.overlayWindowScales.planner).toBe(1.5);
    expect(Object.keys(parsed.overlays.overlayLayouts ?? {})).toHaveLength(6);
    expect(parsed.overlays.rewardLayout?.fields.rarity?.hidden).toBe(true);
    const polluted = JSON.stringify(raw).replace(
      '"filterLayout":{}',
      '"filterLayout":{"__proto__":{"order":["polluted"],"hidden":[]}}',
    );
    expect(parseCustomization(polluted).workspace.filterLayout).toBeUndefined();
    expect({}).not.toHaveProperty("polluted");
  });

  it("preserves edited reward fields alongside an empty general layout map", () => {
    const raw = fixture();
    const parsed = parseCustomization(JSON.stringify(raw));
    expect(parsed.overlays.rewardLayout?.fields.rarity?.hidden).toBe(true);
    expect(parsed.overlays.overlayLayouts?.reward?.fields.rarity?.hidden).toBe(true);
  });

  it("applies stores, preserves existing saved workspaces and keeps imported CSS disabled", async () => {
    customCss.setEnabled(true);
    customCss.save(".mine { color: blue; }");
    await applyCustomization(parseCustomization(JSON.stringify(fixture())));
    expect(get(customCss)).toMatchObject({ enabled: true, css: ".mine { color: blue; }" });
    await applyCustomization(parseCustomization(JSON.stringify(fixture())), true);
    expect(get(themeSettings).colors.accent).toBe("#123456");
    expect(get(inventoryViewMode)).toBe("list");
    expect(get(customCss).enabled).toBe(false);
    expect(get(workspaces).workspaces.map((entry) => entry.name)).toEqual([
      "Example",
      "Example (2)",
    ]);
    expect(invoke.mock.calls.filter(([channel]) => channel === "setOverlaySettings")).toHaveLength(
      2,
    );
  });

  it("does not change renderer settings when saving overlays fails", async () => {
    const previous = get(themeSettings);
    invoke.mockRejectedValueOnce(new Error("save failed"));
    await expect(applyCustomization(parseCustomization(JSON.stringify(fixture())))).rejects.toThrow(
      "save failed",
    );
    expect(get(themeSettings)).toEqual(previous);
    expect(get(workspaces).workspaces).toHaveLength(0);
  });

  it("rejects a workspace-capacity overflow before writing overlays", async () => {
    const raw = fixture();
    raw.savedWorkspaces.workspaces = Array.from({ length: 20 }, (_, index) => ({
      ...raw.workspace,
      id: `saved-${index}`,
    }));
    await applyCustomization(parseCustomization(JSON.stringify(raw)));
    invoke.mockClear();
    await expect(applyCustomization(parseCustomization(JSON.stringify(fixture())))).rejects.toThrow(
      "workspace-capacity",
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(get(workspaces).workspaces).toHaveLength(20);
  });

  it("rejects duplicate and unknown popout targets before mutation", () => {
    for (const popouts of [
      [{ target: { kind: "view", view: "world" } }, { target: { kind: "view", view: "world" } }],
      [{ target: { kind: "view", view: "unknown" } }],
    ]) {
      expect(() =>
        parseCustomization(
          JSON.stringify({ ...fixture(), workspace: { ...fixture().workspace, popouts } }),
        ),
      ).toThrow("invalid-file");
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("allows more than twelve distinct section windows in the portable format", () => {
    const raw = fixture();
    const popouts = Array.from({ length: 13 }, (_, index) => ({
      target: { kind: "section", sectionId: `world.panel${index}` },
    }));
    expect(
      parseCustomization(JSON.stringify({ ...raw, workspace: { ...raw.workspace, popouts } }))
        .workspace.popouts,
    ).toHaveLength(13);
  });

  it("rejects unregistered sections in current and saved workspaces before writing", async () => {
    const raw = fixture();
    const bad = {
      ...raw.workspace,
      popouts: [{ target: { kind: "section", sectionId: "invented.panel" }, pinned: false }],
    };
    for (const candidate of [
      { ...raw, workspace: bad },
      { ...raw, savedWorkspaces: { ...raw.savedWorkspaces, workspaces: [bad] } },
    ]) {
      await expect(
        applyCustomization(parseCustomization(JSON.stringify(candidate))),
      ).rejects.toThrow("invalid-file");
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opens registered eligible sections and refuses registered non-popout sections", async () => {
    registerSections("stats", [
      {
        id: "stats.charts",
        view: "stats",
        labelKey: "common.stats",
        defaultSpan: "full",
        canPopout: true,
      },
      { id: "stats.private", view: "stats", labelKey: "common.stats", defaultSpan: "full" },
    ]);
    try {
      const raw = fixture();
      const eligible = {
        ...raw,
        workspace: {
          ...raw.workspace,
          popouts: [{ target: { kind: "section", sectionId: "stats.charts" }, pinned: true }],
        },
      };
      await applyCustomization(parseCustomization(JSON.stringify(eligible)));
      expect(invoke).toHaveBeenCalledWith(
        "popoutOpen",
        { kind: "section", sectionId: "stats.charts" },
        { pinned: true },
      );
      invoke.mockClear();
      eligible.workspace.popouts[0]!.target.sectionId = "stats.private";
      await expect(
        applyCustomization(parseCustomization(JSON.stringify(eligible))),
      ).rejects.toThrow("invalid-file");
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      registerSections("stats", []);
    }
  });

  it("exports a parseable allowlisted file with sanitized CSS", async () => {
    customCss.save('@import url("https://private.example"); .card { color: red; }');
    const text = await exportCustomization();
    const parsed = parseCustomization(text);
    expect(parsed.customCss).not.toContain("private.example");
    expect(text).not.toContain("notificationSound");
    expect(text).not.toContain("inventoryPath");
    expect(parsed.version).toBe(1);
  });

  it("round trips shared and per-overlay opacity through export and import", async () => {
    themeSettings.resetAll();
    themeSettings.setEffects({ overlayOpacity: 0.65 });
    themeSettings.setOverlayOpacity("reward", 0.3);
    themeSettings.setOverlayOpacity("rivenRight", 0.8);
    themeSettings.saveCustomTheme("Overlay opacity");
    const parsed = parseCustomization(await exportCustomization());
    themeSettings.resetAll();
    await applyCustomization(parsed);
    expect(get(themeSettings).effects).toMatchObject({
      overlayOpacity: 0.65,
      overlayOpacityOverrides: { reward: 0.3, rivenRight: 0.8 },
    });
    expect(get(themeSettings).customThemes[0]?.effects.overlayOpacityOverrides).toEqual({
      reward: 0.3,
      rivenRight: 0.8,
    });
    themeSettings.setOverlayOpacity("reward", null);
    expect(parsed.theme.effects.overlayOpacityOverrides?.reward).toBe(0.3);
    themeSettings.resetAll();
  });
});
