import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), error: vi.fn() }));

vi.mock("../../../src/lib/ipc.js", () => ({ invoke: mocks.invoke }));
vi.mock("../../../src/lib/log.js", () => ({ log: { error: mocks.error } }));

type Store = typeof import("../../../src/stores/overlaySettings");

async function freshStore(): Promise<Store> {
  vi.resetModules();
  mocks.invoke.mockReset();
  mocks.error.mockReset();
  return import("../../../src/stores/overlaySettings.js");
}

beforeEach(() => {
  mocks.invoke.mockReset();
});

describe("ensureOverlaySettingsLoaded", () => {
  it("replaces the defaults with what main has saved", async () => {
    const store = await freshStore();
    expect(get(store.overlaySettings).wfmAwayIdleEnabled).toBe(false);
    mocks.invoke.mockResolvedValue({ wfmAwayIdleEnabled: true, wfmAwayIdleMinutes: 1 });

    await store.ensureOverlaySettingsLoaded();

    expect(get(store.overlaySettings).wfmAwayIdleEnabled).toBe(true);
    expect(get(store.overlaySettings).wfmAwayIdleMinutes).toBe(1);
    expect(get(store.overlaySettingsLoaded)).toBe(true);
  });

  it("asks main once however many views call in", async () => {
    const store = await freshStore();
    mocks.invoke.mockResolvedValue({ wfmAutoIngameEnabled: true });

    await Promise.all([
      store.ensureOverlaySettingsLoaded(),
      store.ensureOverlaySettingsLoaded(),
      store.ensureOverlaySettingsLoaded(),
    ]);
    await store.ensureOverlaySettingsLoaded();

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("lets a later view retry after a failed load", async () => {
    const store = await freshStore();
    mocks.invoke.mockRejectedValueOnce(new Error("ipc down"));

    await store.ensureOverlaySettingsLoaded();
    expect(get(store.overlaySettingsLoaded)).toBe(false);

    mocks.invoke.mockResolvedValue({ wfmAutoIngameEnabled: true });
    await store.ensureOverlaySettingsLoaded();

    expect(get(store.overlaySettings).wfmAutoIngameEnabled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
});
