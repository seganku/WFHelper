import { app } from "electron";

import { overlayPreviewUrl } from "../../services/overlayPreview";
import ctx from "../context";
import {
  assertLocalizedOverlaySender,
  assertMainRendererSender,
  assertOverlayRendererSender,
  handleAuthorized,
  onAuthorized,
} from "../ipcSecurity";
import { overlayMessages } from "../overlayI18n";
import { createOverlayEditor } from "./rewardEditor";
import {
  DEFAULT_OVERLAY_FIELD_STYLE,
  OVERLAY_LAYOUT_KINDS,
  getOverlayDescriptor,
  isOverlayLayoutKind,
  type OverlayLayoutKind,
  type OverlayEditState,
} from "../../config/shared/overlayLayout";
import {
  OVERLAY_EDIT_BEGIN,
  OVERLAY_EDIT_PREVIEW,
  OVERLAY_EDIT_UPDATE,
  OVERLAY_EDIT_END,
  OVERLAY_EDIT_STATE,
  OVERLAY_LAYOUT_GET,
  RELIC_REWARD_PRESENTATION,
} from "../../config/shared/ipcChannels";
import {
  normalizeRewardPresentation,
  type RewardPresentation,
} from "../../config/shared/rewardPresentation";

function liveWindow(kind: OverlayLayoutKind) {
  switch (kind) {
    case "reward":
      return ctx.overlayWindow;
    case "planner":
      return ctx.plannerOverlayWindow;
    case "rivenLeft":
      return ctx.rivenOverlayLeftWindow;
    case "rivenRight":
      return ctx.rivenOverlayRightWindow;
    case "arbiSummary":
      return ctx.arbiSummaryWindow;
    case "tradeNotification":
      return ctx.tradeNotificationWindow;
  }
}

export function registerOverlayEditor(
  persist: () => boolean,
  reposition: (kind: OverlayLayoutKind) => void,
  resolveBounds?: (
    kind: OverlayLayoutKind,
  ) => { width: number; height: number; zoomFactor: number } | null,
) {
  let lastReward: RewardPresentation | null = null;
  onAuthorized(RELIC_REWARD_PRESENTATION, assertOverlayRendererSender, (event, raw: unknown) => {
    const reward = ctx.overlayWindow;
    if (!reward || reward.isDestroyed() || event.sender.id !== reward.webContents.id) return;
    const presentation = normalizeRewardPresentation(raw);
    if (presentation) lastReward = presentation;
  });
  function applySaved(state: OverlayEditState): void {
    const win = liveWindow(state.kind);
    if (win && !win.isDestroyed()) win.webContents.send(OVERLAY_EDIT_STATE, state);
    reposition(state.kind);
  }
  const editor = createOverlayEditor({
    ctx,
    persist,
    applySaved,
    getLastReward: () => lastReward,
  });
  const kindFrom = (raw: unknown): OverlayLayoutKind => {
    if (!isOverlayLayoutKind(raw)) throw new Error("Invalid overlay kind");
    return raw;
  };
  handleAuthorized(OVERLAY_EDIT_BEGIN, assertMainRendererSender, (event, raw: unknown) =>
    editor.begin(event.sender, kindFrom(raw)),
  );
  handleAuthorized(OVERLAY_EDIT_PREVIEW, assertMainRendererSender, (_event, raw: unknown) => {
    const kind = kindFrom(raw);
    const descriptor = getOverlayDescriptor(kind);
    const reward = kind === "reward" ? editor.previewReward() : null;
    const win = liveWindow(kind);
    // The toast has a fixed CSS zoom that its editor deliberately removes.
    const native = kind !== "tradeNotification" && win && !win.isDestroyed() ? win : null;
    const resolved = resolveBounds?.(kind);
    const size = native?.getSize();
    const zoomFactor = native?.webContents.getZoomFactor() ?? resolved?.zoomFactor ?? 1;
    const canvas = {
      width: size
        ? size[0] / zoomFactor
        : resolved
          ? resolved.width / zoomFactor
          : descriptor.canvas.width,
      height: size
        ? size[1] / zoomFactor
        : resolved
          ? resolved.height / zoomFactor
          : descriptor.canvas.height,
    };
    return {
      url: overlayPreviewUrl(app.getAppPath(), kind),
      descriptor: reward
        ? {
            ...descriptor,
            variants: [...descriptor.variants, { value: "last", key: "rewardEditor.previewLast" }],
          }
        : descriptor,
      canvas,
      lastReward: reward,
      theme: { ...ctx.overlayThemeVars },
      messages: overlayMessages(),
      defaultFieldStyle: DEFAULT_OVERLAY_FIELD_STYLE,
    };
  });
  handleAuthorized(
    OVERLAY_EDIT_UPDATE,
    assertMainRendererSender,
    (event, token: unknown, command: unknown) => editor.update(token, command, event.sender),
  );
  handleAuthorized(
    OVERLAY_EDIT_END,
    assertMainRendererSender,
    (event, token: unknown, save: unknown) => editor.end(token, save, event.sender),
  );
  handleAuthorized(OVERLAY_LAYOUT_GET, assertLocalizedOverlaySender, (event) => {
    for (const kind of OVERLAY_LAYOUT_KINDS) {
      if (liveWindow(kind)?.webContents.id === event.sender.id) return editor.savedState(kind);
    }
    throw new Error("Unknown overlay sender");
  });
  return {
    assertIdle() {
      if (editor.state().sessionId)
        throw new Error("Close the overlay editor before importing layouts");
    },
    refresh() {
      for (const kind of OVERLAY_LAYOUT_KINDS) applySaved(editor.savedState(kind));
    },
  };
}
