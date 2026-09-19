const preview = window.overlayPreview;
if (preview) {
  window.arbiSummary = {
    getThemeVars: window.overlay.getThemeVars,
    getMessages: window.overlay.getMessages,
    onThemeVars: window.overlay.onThemeVars,
    onMessages: window.overlay.onMessages,
    ready: () => {},
    moveBy: () => {},
    onData: () => () => {},
    openDetails: () => {},
    close: () => {},
  };
}
let layoutEditor = null;
let _runId = null;
let _summary = null;

const t = window.overlayI18n.t;
function el(id) {
  return document.getElementById(id);
}

function formatDuration(totalSeconds) {
  const duration = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = duration % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function missionLabel(data) {
  if (data.missionType === "defense") return t("arbi.type.defense");
  if (data.missionType === "interception") return t("arbi.type.interception");
  const raw = typeof data.missionTypeRaw === "string" ? data.missionTypeRaw : "";
  // Anything else is the game's own MT_ enum, which only exists in English.
  return raw
    ? raw
        .replace(/^MT_/, "")
        .toLowerCase()
        .replace(/(^|_)\w/g, (c) => c.replace("_", " ").toUpperCase())
    : t("overlay.arbi.missionFallback");
}

function renderSummary() {
  const data = _summary;
  if (!data) return;

  el("run-node").textContent = data.node || t("overlay.arbi.unknownNode");
  el("run-type").textContent = missionLabel(data);
  el("run-duration").textContent = formatDuration(data.durationSec);
  el("run-rotations").textContent = t("overlay.arbi.rotations", {
    count: Number(data.rotations) || 0,
  });

  const locale = window.overlayI18n.getLocale();
  const format = (value, decimals = 1) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
    return value.toLocaleString(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  };
  el("kpi-vitus").textContent = format(data.expectedVitusMean);
  el("kpi-uncertainty").textContent =
    typeof data.expectedVitusStd === "number" &&
    Number.isFinite(data.expectedVitusStd) &&
    data.expectedVitusStd > 0
      ? ` ±${format(data.expectedVitusStd)}`
      : "";
  for (const [id, value, decimals] of [
    ["kpi-actual", data.vitusActual, 0],
    ["kpi-drones", data.drones, 0],
    ["kpi-kills", data.totalEnemies, 0],
    ["kpi-vitus-rate", data.expectedVitusPerMin, 2],
    ["kpi-kill-rate", data.killsPerMin, 1],
    ["kpi-kills-per-drone", data.killsPerDrone, 1],
  ])
    el(id).textContent = format(value, decimals);
  const saturation = format(data.pctTimeAt15Plus);
  el("kpi-saturation").textContent = saturation === "?" ? saturation : `${saturation}%`;
  const interval = format(data.avgDroneIntervalSec);
  el("kpi-drone-interval").textContent = interval === "?" ? interval : `${interval}s`;
  const players = Array.isArray(data.players)
    ? data.players.filter((name) => typeof name === "string" && name.trim())
    : [];
  const squadSize =
    Number.isInteger(data.squadSize) && data.squadSize > 0 && data.squadSize <= 4
      ? ` (${data.squadSize})`
      : "";
  el("run-squad").textContent =
    `${t("relics.squadLabel")}${squadSize}: ${players.length ? players.join(", ") : t("common.unknown")}`;
  el("run-end").textContent =
    data.endReason === "aborted" ? t("arbi.end.aborted") : t("arbi.end.mission-end");
}

function onSummaryData(data) {
  if (!data || typeof data !== "object") return;
  _runId = typeof data.id === "string" ? data.id : null;
  _summary = data;
  renderSummary();
}

function renderSummaryPreview(state) {
  const unknown = state.previewVariant === "unknown";
  const long = state.previewVariant === "long";
  onSummaryData({
    id: "preview",
    node: long ? "Outer Terminus (Pluto)" : "Casta (Ceres)",
    missionType: long ? "interception" : "defense",
    durationSec: 1842,
    rotations: 6,
    expectedVitusMean: 48.5,
    expectedVitusStd: unknown ? null : 6.2,
    drones: 184,
    totalEnemies: 4238,
    pctTimeAt15Plus: 74.2,
    vitusActual: unknown ? null : 51,
    expectedVitusPerMin: unknown ? null : 1.58,
    killsPerMin: unknown ? null : 138,
    killsPerDrone: unknown ? null : 23,
    avgDroneIntervalSec: unknown ? null : 9.8,
    players: unknown
      ? []
      : long
        ? ["TennoWithALongerName", "SecondSquadMember", "ThirdTenno", "FourthTenno"]
        : ["Tenno", "Volt", "Wisp", "Nova"],
    squadSize: unknown ? null : 4,
    endReason: long ? "aborted" : "mission-end",
  });
}

document.addEventListener("DOMContentLoaded", () => {
  let bootstrapped = false;
  const finishBootstrap = (loaded) => {
    if (!loaded || bootstrapped) return;
    bootstrapped = true;
    layoutEditor = window.installOverlayLayout({
      ...(preview ? { defaultFieldStyle: preview.config.defaultFieldStyle } : {}),
      renderPreview: renderSummaryPreview,
    });
    window.arbiSummary.ready();
  };
  window.overlayTheme.bootstrapOverlayTheme(() => window.arbiSummary.getThemeVars(), "arbiSummary");

  el("btn-close").addEventListener("click", () => {
    if (!preview) window.arbiSummary.close();
  });
  el("btn-details").addEventListener("click", () => {
    if (!preview && _runId) window.arbiSummary.openDetails(_runId);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (preview) layoutEditor?.cancel();
      else window.arbiSummary.close();
    }
  });

  window.installOverlayDrag({
    isInteractive: () => !preview,
    moveBy: (dx, dy) => window.arbiSummary.moveBy(dx, dy),
  });

  window.arbiSummary.onData(onSummaryData);
  window.arbiSummary.onThemeVars((vars) => {
    window.overlayTheme.applyThemeVars(vars);
    layoutEditor?.refresh();
  });
  window.arbiSummary.onMessages((messages) => finishBootstrap(window.overlayI18n.apply(messages)));
  // Header and KPI values are rebuilt from the stored run on a language change.
  window.overlayI18n.onApply(renderSummary);
  void window.overlayI18n.load(() => window.arbiSummary.getMessages()).then(finishBootstrap);
});
