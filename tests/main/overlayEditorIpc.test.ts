import { EventEmitter } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";

import { OVERLAY_SETTINGS_DEFAULTS } from "../../config/runtime/overlaySettings";
import {
  OVERLAY_EDIT_BEGIN,
  OVERLAY_EDIT_STATE,
  OVERLAY_EDIT_END,
  OVERLAY_EDIT_PREVIEW,
  OVERLAY_EDIT_UPDATE,
  OVERLAY_LAYOUT_GET,
  RELIC_REWARD_PRESENTATION,
} from "../../config/shared/ipcChannels";
import {
  DEFAULT_OVERLAY_FIELD_STYLE,
  OVERLAY_LAYOUT_KINDS,
  getOverlayDescriptor,
  type OverlayEditState,
} from "../../config/shared/overlayLayout";
import ctx from "../../ipc/context";
import { registerOverlayEditor } from "../../ipc/overlay/editorIpc";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  events: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => void>(),
}));
vi.mock("electron", () => ({
  app: { getAppPath: () => process.cwd() },
  ipcMain: {
    on: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => void) =>
      mocks.events.set(channel, handler),
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
    ) => mocks.handlers.set(channel, handler),
  },
}));
vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../ipc/overlayI18n", () => ({
  overlayMessages: () => ({ locale: "en", messages: {} }),
}));

function windowStub(id: number, file: string) {
  const url = pathToFileURL(path.join(process.cwd(), "renderer", file)).href;
  const contents = Object.assign(new EventEmitter(), {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
    getURL: () => url,
    getZoomFactor: vi.fn(() => 1),
  });
  const window = {
    isDestroyed: () => false,
    webContents: contents,
    getSize: vi.fn(() => [980, 236]),
  } as unknown as BrowserWindow;
  const event = {
    sender: contents as unknown as WebContents,
    senderFrame: { url },
  } as IpcMainInvokeEvent;
  return { window, event, contents };
}

function invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC ${channel}`);
  return handler(event, ...args);
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.events.clear();
  ctx.mainWindow = null;
  ctx.overlayWindow = null;
  ctx.plannerOverlayWindow = null;
  ctx.rivenOverlayLeftWindow = null;
  ctx.rivenOverlayRightWindow = null;
  ctx.arbiSummaryWindow = null;
  ctx.tradeNotificationWindow = null;
  ctx.overlaySettings = {
    ...OVERLAY_SETTINGS_DEFAULTS,
    fissureAlerts: [],
    overlayLayouts: {
      planner: {
        version: 1,
        fields: { relicName: { ...DEFAULT_OVERLAY_FIELD_STYLE, color: "#aabbcc" } },
      },
    },
  };
});

describe("overlay editor IPC boundaries", () => {
  it("accepts only the reward sender and freezes a completed presentation for one editor session", async () => {
    const main = windowStub(1, "dist/index.html");
    const reward = windowStub(2, "overlay.html");
    const planner = windowStub(3, "overlay.html");
    ctx.mainWindow = main.window;
    ctx.overlayWindow = reward.window;
    ctx.plannerOverlayWindow = planner.window;
    const persist = vi.fn(() => true);
    registerOverlayEditor(persist, vi.fn());
    const report = mocks.events.get(RELIC_REWARD_PRESENTATION)!;
    const item = {
      name: "Forma Blueprint",
      rarity: "common",
      ducats: 0,
      partOwnedCount: 0,
      partRequiredCount: 0,
      building: false,
      setOwnedCount: 0,
      setRequiredCount: 0,
      setUrlName: null,
      setParts: [],
    };
    const presentation = { count: 1, slots: [null, null, { item, price: 0, setPrice: 0 }, null] };
    report(main.event, presentation);
    report(planner.event, presentation);
    const before = await invoke(OVERLAY_EDIT_PREVIEW, main.event, "reward");
    expect(before).toMatchObject({ lastReward: null });
    const emptyDraft = (await invoke(OVERLAY_EDIT_BEGIN, main.event, "reward")) as OverlayEditState;
    await expect(
      invoke(OVERLAY_EDIT_UPDATE, main.event, emptyDraft.sessionId, {
        type: "preview",
        count: 1,
        variant: "last",
      }),
    ).rejects.toThrow("Invalid preview");
    await invoke(OVERLAY_EDIT_END, main.event, emptyDraft.sessionId, false);

    report(reward.event, presentation);
    const draft = (await invoke(OVERLAY_EDIT_BEGIN, main.event, "reward")) as OverlayEditState;
    item.name = "Changed input";
    report(reward.event, { ...presentation, count: 4 });
    const preview = (await invoke(OVERLAY_EDIT_PREVIEW, main.event, "reward")) as {
      lastReward: typeof presentation;
      descriptor: { variants: { value: string }[] };
    };
    expect(preview.lastReward.slots[2]?.item.name).toBe("Forma Blueprint");
    expect(preview.descriptor.variants.some((variant) => variant.value === "last")).toBe(true);
    const last = (await invoke(OVERLAY_EDIT_UPDATE, main.event, draft.sessionId, {
      type: "preview",
      count: 4,
      variant: "last",
    })) as OverlayEditState;
    expect(last.previewCount).toBe(1);
    expect(last.previewVariant).toBe("last");

    report(reward.event, presentation);
    expect(await invoke(OVERLAY_EDIT_PREVIEW, main.event, "reward")).toMatchObject({
      lastReward: { slots: [null, null, { item: { name: "Forma Blueprint" } }, null] },
    });
    preview.lastReward.slots[2]!.item.name = "Changed preview response";
    expect(await invoke(OVERLAY_EDIT_PREVIEW, main.event, "reward")).toMatchObject({
      lastReward: { slots: [null, null, { item: { name: "Forma Blueprint" } }, null] },
    });
    await invoke(OVERLAY_EDIT_END, main.event, draft.sessionId, false);
    expect(await invoke(OVERLAY_EDIT_PREVIEW, main.event, "reward")).toMatchObject({
      lastReward: { slots: [null, null, { item: { name: "Changed input" } }, null] },
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("resolves logical preview dimensions from live size and zoom, or canonical saved bounds", async () => {
    const main = windowStub(1, "dist/index.html");
    const reward = windowStub(2, "overlay.html");
    ctx.mainWindow = main.window;
    ctx.overlayWindow = reward.window;
    vi.mocked(reward.window.getSize).mockReturnValue([900, 375]);
    reward.contents.getZoomFactor.mockReturnValue(1.25);
    const bounds = vi.fn(() => ({ width: 1000, height: 500, zoomFactor: 1.25 }));
    registerOverlayEditor(
      vi.fn(() => true),
      vi.fn(),
      bounds,
    );
    expect(await invoke(OVERLAY_EDIT_PREVIEW, main.event, "reward")).toMatchObject({
      canvas: { width: 720, height: 300 },
    });
    ctx.overlayWindow = null;
    expect(await invoke(OVERLAY_EDIT_PREVIEW, main.event, "reward")).toMatchObject({
      canvas: { width: 800, height: 400 },
    });
    expect(bounds).toHaveBeenCalledWith("reward");
  });

  it("saves an offset dragged inside a grown window and still bounds a hostile one", async () => {
    const main = windowStub(1, "dist/index.html");
    const reward = windowStub(2, "overlay.html");
    ctx.mainWindow = main.window;
    ctx.overlayWindow = reward.window;
    vi.mocked(reward.window.getSize).mockReturnValue([980, 420]);
    const persist = vi.fn(() => true);
    registerOverlayEditor(persist, vi.fn());
    expect(await invoke(OVERLAY_EDIT_PREVIEW, main.event, "reward")).toMatchObject({
      canvas: { width: 980, height: 420 },
      descriptor: { canvas: { width: 980, height: 236 } },
    });
    const draft = (await invoke(OVERLAY_EDIT_BEGIN, main.event, "reward")) as OverlayEditState;
    const move = (y: number) =>
      invoke(OVERLAY_EDIT_UPDATE, main.event, draft.sessionId, {
        type: "field",
        field: "itemName",
        patch: { y },
      }) as Promise<OverlayEditState>;
    expect((await move(1e9)).layout.fields.itemName).toMatchObject({ y: 10_000 });
    expect((await move(-1e9)).layout.fields.itemName).toMatchObject({ y: -10_000 });
    expect((await move(390)).layout.fields.itemName).toMatchObject({ y: 390 });
    await invoke(OVERLAY_EDIT_END, main.event, draft.sessionId, true);
    expect(persist).toHaveBeenCalledOnce();
    expect(
      ((await invoke(OVERLAY_LAYOUT_GET, reward.event)) as OverlayEditState).layout.fields.itemName,
    ).toMatchObject({ y: 390 });
  });

  it("keeps Arbitration offsets saved with the former taller canvas", async () => {
    const arbi = windowStub(1, "arbi-overlay.html");
    ctx.arbiSummaryWindow = arbi.window;
    ctx.overlaySettings.overlayLayouts = {
      arbiSummary: {
        version: 1,
        fields: { vitusValue: { ...DEFAULT_OVERLAY_FIELD_STYLE, y: 440 } },
      },
    };
    registerOverlayEditor(
      vi.fn(() => true),
      vi.fn(),
    );
    expect(
      ((await invoke(OVERLAY_LAYOUT_GET, arbi.event)) as OverlayEditState).layout.fields.vitusValue,
    ).toMatchObject({ y: 440 });
  });

  it("returns only the live sender's saved layout while another renderer owns a draft", async () => {
    const main = windowStub(1, "dist/index.html");
    const planner = windowStub(2, "overlay.html");
    const reward = windowStub(3, "overlay.html");
    ctx.mainWindow = main.window;
    ctx.plannerOverlayWindow = planner.window;
    ctx.overlayWindow = reward.window;
    const persist = vi.fn(() => true);
    const reposition = vi.fn();
    registerOverlayEditor(persist, reposition);
    const draft = (await invoke(OVERLAY_EDIT_BEGIN, main.event, "planner")) as OverlayEditState;
    await invoke(OVERLAY_EDIT_UPDATE, main.event, draft.sessionId, {
      type: "field",
      field: "relicName",
      patch: { hidden: true },
    });
    const saved = (await invoke(OVERLAY_LAYOUT_GET, planner.event)) as OverlayEditState;
    expect(saved).toMatchObject({ kind: "planner", sessionId: null });
    expect(saved.layout.fields.relicName).toMatchObject({ color: "#aabbcc", hidden: false });
    expect(await invoke(OVERLAY_LAYOUT_GET, reward.event)).toMatchObject({
      kind: "reward",
      sessionId: null,
    });
    expect(planner.contents.send).not.toHaveBeenCalled();
    await invoke(OVERLAY_EDIT_END, main.event, draft.sessionId, true);
    expect(planner.contents.send).toHaveBeenCalledOnce();
    expect(reward.contents.send).not.toHaveBeenCalled();
    expect(reposition).toHaveBeenCalledExactlyOnceWith("planner");
    expect(
      ((await invoke(OVERLAY_LAYOUT_GET, planner.event)) as OverlayEditState).layout.fields
        .relicName?.hidden,
    ).toBe(true);
  });

  it("blocks imported layouts while a draft is active and permits them after cancel", async () => {
    const main = windowStub(1, "dist/index.html");
    ctx.mainWindow = main.window;
    const controls = registerOverlayEditor(
      vi.fn(() => true),
      vi.fn(),
    );
    expect(() => controls.assertIdle()).not.toThrow();
    const draft = (await invoke(OVERLAY_EDIT_BEGIN, main.event, "planner")) as OverlayEditState;
    expect(() => controls.assertIdle()).toThrow(
      "Close the overlay editor before importing layouts",
    );
    await invoke(OVERLAY_EDIT_END, main.event, draft.sessionId, false);
    expect(() => controls.assertIdle()).not.toThrow();
  });

  it("refreshes all six live windows from saved layouts and repositions each", () => {
    const windows = OVERLAY_LAYOUT_KINDS.map((_kind, index) =>
      windowStub(index + 2, "overlay.html"),
    );
    ctx.overlayWindow = windows[0]!.window;
    ctx.plannerOverlayWindow = windows[1]!.window;
    ctx.rivenOverlayLeftWindow = windows[2]!.window;
    ctx.rivenOverlayRightWindow = windows[3]!.window;
    ctx.arbiSummaryWindow = windows[4]!.window;
    ctx.tradeNotificationWindow = windows[5]!.window;
    const reposition = vi.fn();
    const persist = vi.fn(() => true);
    const controls = registerOverlayEditor(persist, reposition);
    ctx.overlaySettings.overlayLayouts = Object.fromEntries(
      OVERLAY_LAYOUT_KINDS.map((kind) => [
        kind,
        {
          version: 1,
          fields: {
            [getOverlayDescriptor(kind).fields[0]!]: {
              ...DEFAULT_OVERLAY_FIELD_STYLE,
              color: "#123456",
              hidden: true,
            },
          },
        },
      ]),
    );
    ctx.overlaySettings.rewardLayout = ctx.overlaySettings.overlayLayouts.reward;
    controls.refresh();
    for (const [index, kind] of OVERLAY_LAYOUT_KINDS.entries()) {
      const field = getOverlayDescriptor(kind).fields[0]!;
      expect(windows[index]!.contents.send).toHaveBeenCalledExactlyOnceWith(
        OVERLAY_EDIT_STATE,
        expect.objectContaining({
          kind,
          sessionId: null,
          layout: expect.objectContaining({
            fields: expect.objectContaining({
              [field]: expect.objectContaining({ hidden: true, color: "#123456" }),
            }),
          }),
        }),
      );
      expect(reposition).toHaveBeenCalledWith(kind);
    }
    expect(reposition).toHaveBeenCalledTimes(6);
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects native mutation, main-window layout reads and iframe sender impersonation", async () => {
    const main = windowStub(1, "dist/index.html");
    const native = windowStub(2, "riven-overlay.html");
    ctx.mainWindow = main.window;
    ctx.rivenOverlayLeftWindow = native.window;
    registerOverlayEditor(
      vi.fn(() => true),
      vi.fn(),
    );
    const draft = (await invoke(OVERLAY_EDIT_BEGIN, main.event, "rivenLeft")) as OverlayEditState;
    for (const [channel, args] of [
      [OVERLAY_EDIT_BEGIN, ["rivenLeft"]],
      [OVERLAY_EDIT_PREVIEW, ["rivenLeft"]],
      [OVERLAY_EDIT_UPDATE, [draft.sessionId, { type: "reset" }]],
      [OVERLAY_EDIT_END, [draft.sessionId, true]],
    ] as const)
      await expect(invoke(channel, native.event, ...args)).rejects.toThrow(
        "Unauthorized IPC sender",
      );
    await expect(invoke(OVERLAY_LAYOUT_GET, main.event)).rejects.toThrow("Unauthorized IPC sender");
    const iframe = {
      ...main.event,
      senderFrame: {
        url:
          pathToFileURL(path.join(process.cwd(), "renderer", "overlay.html")).href +
          "?mode=editor&kind=reward",
      },
    } as IpcMainInvokeEvent;
    await expect(
      invoke(OVERLAY_EDIT_UPDATE, iframe, draft.sessionId, { type: "reset" }),
    ).rejects.toThrow("Unauthorized IPC sender");
    const wrongUrl = {
      ...native.event,
      senderFrame: { url: "https://example.com/renderer/riven-overlay.html" },
    } as IpcMainInvokeEvent;
    await expect(invoke(OVERLAY_LAYOUT_GET, wrongUrl)).rejects.toThrow("Unauthorized IPC sender");
    await invoke(OVERLAY_EDIT_END, main.event, draft.sessionId, false);
  });

  it.each([undefined, null, "__proto__", "constructor", "riven", { kind: "reward" }])(
    "rejects unsupported preview kinds: %j",
    async (kind) => {
      const main = windowStub(1, "dist/index.html");
      ctx.mainWindow = main.window;
      registerOverlayEditor(
        vi.fn(() => true),
        vi.fn(),
      );
      await expect(invoke(OVERLAY_EDIT_BEGIN, main.event, kind)).rejects.toThrow(
        "Invalid overlay kind",
      );
      await expect(invoke(OVERLAY_EDIT_PREVIEW, main.event, kind)).rejects.toThrow(
        "Invalid overlay kind",
      );
    },
  );
});
