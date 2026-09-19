<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import { FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP } from "../../config/themeDefaults.js";
  import ThemedControlCard from "../ThemedControlCard.svelte";

  $: fontSizes = $themeSettings.fontSizes;
  let draftScale: number | null = null;
  $: scaleValue = draftScale ?? fontSizes.globalScale;
  $: scalePercent = Math.round(scaleValue * 100);

  function clampScale(value: number): number {
    return Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, value));
  }

  function onScaleInput(event: Event): void {
    const parsed = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(parsed)) draftScale = clampScale(parsed);
  }

  function onScaleCommit(): void {
    if (draftScale === null) return;
    const value = draftScale;
    draftScale = null;
    themeSettings.setGlobalScale(value);
  }

  function onScalePercentCommit(event: Event): void {
    const input = event.target as HTMLInputElement;
    const parsed = Number(input.value);
    if (!input.value.trim() || !Number.isFinite(parsed)) {
      input.value = String(scalePercent);
      return;
    }
    const value = clampScale(parsed / 100);
    draftScale = null;
    input.value = String(Math.round(value * 100));
    themeSettings.setGlobalScale(value);
  }

  function parseOptionalRem(event: Event): number | undefined {
    const input = event.target as HTMLInputElement;
    const raw = input.value.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.max(0.3, Math.min(5, n));
  }

  const onFontSizeChange =
    (key: "headingSize" | "bodySize" | "smallSize") =>
    (event: Event): void => {
      themeSettings.setOptionalFontSize(key, parseOptionalRem(event));
    };
</script>

<div class="appearance-section" data-font-sizes>
  <div class="appearance-section-head">
    <h4 class="appearance-section-label">{$tr("appearance.fontSizes")}</h4>
    <button class="btn-secondary btn-sm" on:click={() => themeSettings.resetFontSizes()}>
      {$tr("common.reset")}
    </button>
  </div>

  <div class="grid gap-2">
    <ThemedControlCard as="label" density="tight">
      <span class="text-text-secondary text-xs font-medium">{$tr("appearance.globalScale")}</span>
      <div class="flex items-center gap-1.5">
        <input
          type="range"
          class="w-32 min-w-0 accent-accent"
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={FONT_SCALE_STEP}
          value={scaleValue}
          on:input={onScaleInput}
          on:change={onScaleCommit}
        />
        <input
          type="number"
          class="w-16 min-w-0 border border-[var(--ui-control-border)] rounded-[var(--radius-md)] bg-bg-base text-text-primary text-xs py-1 px-2 outline-none text-right focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
          min={Math.round(FONT_SCALE_MIN * 100)}
          max={Math.round(FONT_SCALE_MAX * 100)}
          step={Math.round(FONT_SCALE_STEP * 100)}
          value={scalePercent}
          on:blur={onScalePercentCommit}
          on:keydown={(event) => {
            if (event.key === "Enter") onScalePercentCommit(event);
          }}
        />
        <span class="font-display text-xs font-bold text-accent">%</span>
      </div>
    </ThemedControlCard>

    <ThemedControlCard as="label" density="tight">
      <span class="text-text-secondary text-xs font-medium">{$tr("appearance.headingSize")}</span>
      <input
        type="number"
        class="w-20 border border-[var(--ui-control-border)] rounded-[var(--radius-md)] bg-bg-base text-text-primary text-sm py-1 px-2 outline-none text-right focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
        min="0.5"
        max="5"
        step="0.05"
        placeholder="auto"
        value={fontSizes.headingSize ?? ""}
        on:input={onFontSizeChange("headingSize")}
      />
    </ThemedControlCard>

    <ThemedControlCard as="label" density="tight">
      <span class="text-text-secondary text-xs font-medium">{$tr("appearance.bodySize")}</span>
      <input
        type="number"
        class="w-20 border border-[var(--ui-control-border)] rounded-[var(--radius-md)] bg-bg-base text-text-primary text-sm py-1 px-2 outline-none text-right focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
        min="0.5"
        max="5"
        step="0.05"
        placeholder="auto"
        value={fontSizes.bodySize ?? ""}
        on:input={onFontSizeChange("bodySize")}
      />
    </ThemedControlCard>

    <ThemedControlCard as="label" density="tight">
      <span class="text-text-secondary text-xs font-medium">{$tr("appearance.smallSize")}</span>
      <input
        type="number"
        class="w-20 border border-[var(--ui-control-border)] rounded-[var(--radius-md)] bg-bg-base text-text-primary text-sm py-1 px-2 outline-none text-right focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
        min="0.3"
        max="3"
        step="0.05"
        placeholder="auto"
        value={fontSizes.smallSize ?? ""}
        on:input={onFontSizeChange("smallSize")}
      />
    </ThemedControlCard>
  </div>
</div>
