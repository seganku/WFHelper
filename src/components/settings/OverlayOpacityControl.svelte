<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import {
    OVERLAY_OPACITY_MAX,
    OVERLAY_OPACITY_MIN,
  } from "../../../config/shared/overlayOpacity.js";
  import {
    getOverlayDescriptor,
    OVERLAY_LAYOUT_KINDS,
    type OverlayLayoutKind,
  } from "../../../config/shared/overlayLayout.js";

  let draftOpacity: number | null = $state(null);
  let draftOverride: { kind: OverlayLayoutKind; value: number } | null = $state(null);

  const opacityPercent = $derived(
    Math.round((draftOpacity ?? $themeSettings.effects.overlayOpacity) * 100),
  );

  function onOpacityInput(percent: number): void {
    if (Number.isFinite(percent)) draftOpacity = percent / 100;
  }

  function onOpacityCommit(): void {
    if (draftOpacity === null) return;
    const value = draftOpacity;
    draftOpacity = null;
    themeSettings.setEffects({ overlayOpacity: value });
  }

  function onOverrideInput(kind: OverlayLayoutKind, percent: number): void {
    if (Number.isFinite(percent)) draftOverride = { kind, value: percent / 100 };
  }

  function onOverrideCommit(kind: OverlayLayoutKind): void {
    if (draftOverride === null || draftOverride.kind !== kind) return;
    const value = draftOverride.value;
    draftOverride = null;
    themeSettings.setOverlayOpacity(kind, value);
  }

  function onOverrideClear(kind: OverlayLayoutKind): void {
    if (draftOverride?.kind === kind) draftOverride = null;
    themeSettings.setOverlayOpacity(kind, null);
  }
</script>

<label
  class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5"
  data-overlay-opacity-control
>
  <span class="min-w-0 flex-[1_1_5rem] text-text-secondary text-xs font-medium">
    {$tr("appearance.overlayOpacity")}
    <span class="block text-xs text-text-muted font-normal mt-0.5"
      >{$tr("appearance.overlayOpacityHint")}</span
    >
  </span>
  <span class="flex min-w-0 flex-[1_1_8rem] items-center gap-2">
    <input
      type="range"
      min={OVERLAY_OPACITY_MIN * 100}
      max={OVERLAY_OPACITY_MAX * 100}
      step="1"
      class="w-full accent-accent"
      aria-label={$tr("appearance.overlayOpacity")}
      value={opacityPercent}
      oninput={(event) => onOpacityInput(event.currentTarget.valueAsNumber)}
      onchange={onOpacityCommit}
    />
    <span class="w-10 shrink-0 text-right text-xs text-text-primary tabular-nums"
      >{opacityPercent}%</span
    >
  </span>
</label>

<details class="mt-2 text-xs" data-overlay-opacity-overrides>
  <summary class="cursor-pointer text-text-secondary"
    >{$tr("appearance.overlayOpacityCustomize")}</summary
  >
  <div class="mt-2 space-y-3">
    {#each OVERLAY_LAYOUT_KINDS as kind (kind)}
      {@const override = $themeSettings.effects.overlayOpacityOverrides?.[kind]}
      {@const draft = draftOverride?.kind === kind ? draftOverride.value : null}
      {@const percent = Math.round(
        (draft ?? override ?? $themeSettings.effects.overlayOpacity) * 100,
      )}
      <div data-overlay-opacity-kind={kind} class="space-y-1">
        <div class="flex flex-wrap items-center justify-between gap-1">
          <label for={`overlay-opacity-${kind}`} class="text-text-secondary">
            {$tr(getOverlayDescriptor(kind).titleKey)}
          </label>
          <button
            type="button"
            class="text-text-muted hover:text-text-primary disabled:cursor-default disabled:hover:text-text-muted"
            disabled={override === undefined}
            onclick={() => onOverrideClear(kind)}
            >{$tr(
              override === undefined
                ? "appearance.overlayOpacityInherited"
                : "appearance.overlayOpacityUseGlobal",
            )}</button
          >
        </div>
        <div class="flex items-center gap-2">
          <input
            id={`overlay-opacity-${kind}`}
            type="range"
            min={OVERLAY_OPACITY_MIN * 100}
            max={OVERLAY_OPACITY_MAX * 100}
            step="1"
            class="min-w-0 w-full accent-accent"
            value={percent}
            oninput={(event) => onOverrideInput(kind, event.currentTarget.valueAsNumber)}
            onchange={() => onOverrideCommit(kind)}
          />
          <span class="w-10 shrink-0 text-right text-text-primary tabular-nums">{percent}%</span>
        </div>
      </div>
    {/each}
  </div>
</details>
