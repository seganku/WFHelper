<script lang="ts">
  import ItemImage from "../ItemImage.svelte";
  import ItemTile from "../ItemTile.svelte";
  import SegmentedControl from "../SegmentedControl.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import { CREDITS_ICON_URL } from "../../lib/assetUrls.js";
  import { formatNumber } from "../../lib/format.js";
  import { itemLabel } from "../../lib/itemLabel.js";
  import { locale, tr } from "../../lib/i18n.js";
  import { buildItemNameIndex } from "../../lib/componentResolution.js";
  import {
    groupPlannedItems,
    missingOnly,
    plannerModalTarget,
    plannerPartState,
    unfinishedParts,
    type MasteryPlan,
    type PlannedItem,
    type PlannerSort,
  } from "../../lib/masteryPlanner.js";
  import { masteryCraftableCount, masteryPartCounts } from "../../lib/masteryRoadmap.js";
  import { creditsRow } from "../../lib/syndicates/rankup.js";
  import { inventoryData, itemDb } from "../../stores/data.js";
  import type { ComponentInfo } from "../../types/inventory.js";

  interface Props {
    plan: MasteryPlan;
    sort: PlannerSort;
    onSort: (value: PlannerSort) => void;
    onUnpin: (uniqueName: string) => void;
    onOpenItem: (uniqueName: string) => void;
    onOpenComponent: (comp: ComponentInfo, parentName: string) => void;
  }

  let { plan, sort, onSort, onUnpin, onOpenItem, onOpenComponent }: Props = $props();

  interface MaterialRow {
    key: string;
    label: string;
    iconUrl?: string;
    owned: number;
    needed: number;
    missing: number;
  }

  const MATERIAL_CHIP_LIMIT = 4;

  let showCovered = $state(false);
  let expandedMaterials = $state<Record<string, boolean>>({});

  const groups = $derived(groupPlannedItems(plan.items, sort, itemLabel));
  const shortTotals = $derived(missingOnly(plan.totals));
  const visibleTotals = $derived(showCovered ? plan.totals : shortTotals);
  const credits = $derived(creditsRow(plan.totalCredits, $inventoryData));
  const creditsVisible = $derived(credits.needed > 0 && (showCovered || credits.missing > 0));
  const sortedRows: MaterialRow[] = $derived(
    [
      ...visibleTotals.map((row) => ({
        key: row.uniqueName,
        label: itemLabel(row),
        owned: row.owned,
        needed: row.needed,
        missing: row.missing,
      })),
      ...(creditsVisible
        ? [
            {
              key: "credits",
              label: $tr("common.credits"),
              iconUrl: CREDITS_ICON_URL,
              owned: credits.owned,
              needed: credits.needed,
              missing: credits.missing,
            },
          ]
        : []),
    ].sort((a, b) => {
      if (a.missing > 0 !== b.missing > 0) return a.missing > 0 ? -1 : 1;
      if (a.missing > 0) return missingShare(b) - missingShare(a);
      return a.label.localeCompare(b.label);
    }),
  );
  const hiddenRows = $derived(
    plan.totals.length - shortTotals.length + (credits.needed > 0 && credits.missing <= 0 ? 1 : 0),
  );
  const allRowCount = $derived(plan.totals.length + (credits.needed > 0 ? 1 : 0));
  const plannedXp = $derived(plan.items.reduce((sum, item) => sum + item.masteryXpRemaining, 0));
  const sortOptions = $derived([
    { value: "mastery_xp" as const, label: $tr("mastery.sort.masteryXp") },
    { value: "completeness" as const, label: $tr("mastery.planner.sortCompleteness") },
    { value: "name" as const, label: $tr("common.name") },
  ]);

  function missingShare(row: { missing: number; needed: number }): number {
    return row.needed > 0 ? row.missing / row.needed : 0;
  }

  function coveredPercent(row: { owned: number; needed: number; missing: number }): number {
    if (row.missing <= 0) return 100;
    const fraction = row.needed > 0 ? Math.max(0, Math.min(1, row.owned / row.needed)) : 1;
    return Math.floor(fraction * 100);
  }

  function toggleMaterials(uniqueName: string): void {
    expandedMaterials[uniqueName] = !expandedMaterials[uniqueName];
  }

  const nameIndex = $derived(buildItemNameIndex($itemDb));

  function openRow(entry: {
    uniqueName: string;
    name: string;
    displayName?: string;
    needed: number;
    owned: number;
    missing: number;
  }): void {
    const target = plannerModalTarget(entry, $itemDb, nameIndex);
    onOpenComponent(target.comp, target.parentName);
  }
</script>

{#snippet materialBar(row: MaterialRow)}
  {@const percent = coveredPercent(row)}
  {@const shortfall =
    row.missing > 0 ? `\n${$tr("common.missing")} ${row.missing.toLocaleString($locale)}` : ""}
  {@const detail = `${row.label}\n${row.owned.toLocaleString($locale)} / ${row.needed.toLocaleString($locale)}${shortfall}`}
  <div
    class="material-bar relative flex min-w-0 items-center gap-2 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2 py-1.5"
    role="img"
    aria-label={detail}
    title={detail}
  >
    <span class="material-bar__fill" class:covered={row.missing <= 0} style="width: {percent}%"
    ></span>
    {#if row.iconUrl}
      <img src={row.iconUrl} alt="" class="relative h-4 w-4 shrink-0 object-contain" />
    {/if}
    <span class="relative min-w-0 flex-1 truncate text-xs text-text-primary">{row.label}</span>
    <span
      class="material-bar__value relative w-[6.25rem] shrink-0 text-right text-xs tabular-nums text-text-primary"
      >{formatNumber(row.owned, $locale)} / {formatNumber(row.needed, $locale)}</span
    >
    <span
      class="material-bar__value relative w-[2.75rem] shrink-0 text-right font-display text-xs tabular-nums text-text-primary"
      >{percent}%</span
    >
  </div>
{/snippet}

{#snippet plannedCard(item: PlannedItem)}
  {@const listedParts = unfinishedParts(item.components)}
  {@const parts = masteryPartCounts(item.components.map(plannerPartState))}
  {@const craftable = masteryCraftableCount(item.components, plannerPartState, $itemDb || {})}
  {@const missingMaterials = missingOnly(item.resources)}
  {@const materialsOpen = expandedMaterials[item.uniqueName] === true}
  {@const shownMaterials = materialsOpen
    ? missingMaterials
    : missingMaterials.slice(0, MATERIAL_CHIP_LIMIT)}
  <div
    class="grid min-w-0 content-start gap-2 rounded-[var(--radius-lg)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-2.5"
    data-planner-row={item.uniqueName}
  >
    <div class="grid min-w-0 grid-cols-[4rem_minmax(0,1fr)_auto] items-center gap-3">
      <span
        class="flex h-16 w-16 items-center justify-center overflow-hidden rounded-[var(--radius-md)] bg-surface-card"
      >
        <ItemImage
          src={item.imageUrl}
          alt={itemLabel(item)}
          auditKey={item.name}
          cls="max-h-full max-w-full object-contain"
        />
      </span>
      <span class="min-w-0">
        <strong class="block truncate font-display text-base text-text-primary"
          >{itemLabel(item)}</strong
        >
        <span class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
          {#if item.masteryXpRemaining > 0}
            <span class="planner-badge xp"
              >{$tr("mastery.roadmap.xpAmount", {
                amount: item.masteryXpRemaining.toLocaleString($locale),
              })}</span
            >
          {/if}
          {#if !item.hasRecipe}
            <span>{$tr("mastery.planner.noRecipe")}</span>
          {:else if item.craftableNow}
            <span class="planner-badge ready">{$tr("mastery.planner.craftableNow")}</span>
          {:else}
            <span class="tabular-nums">{Math.round(item.completeness * 100)}%</span>
          {/if}
        </span>
      </span>
      <span class="flex items-center gap-1">
        <button
          type="button"
          class="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-surface-card text-text-muted hover:border-accent-dim hover:text-accent"
          title={$tr("common.openDetailsFor", { name: itemLabel(item) })}
          aria-label={$tr("common.openDetailsFor", { name: itemLabel(item) })}
          onclick={() => onOpenItem(item.uniqueName)}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            class="h-3.5 w-3.5"
          >
            <circle cx="8" cy="8" r="6" />
            <path d="M8 7v4M8 5h.01" />
          </svg>
        </button>
        <button
          type="button"
          class="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-surface-card text-text-muted hover:border-accent-dim hover:text-accent"
          title={$tr("mastery.planner.unpin")}
          aria-label={$tr("mastery.planner.unpin")}
          data-mastery-pin={item.uniqueName}
          onclick={() => onUnpin(item.uniqueName)}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            class="h-3.5 w-3.5"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </span>
    </div>

    {#if item.hasRecipe}
      <svg
        class="block h-1 w-full overflow-hidden rounded-full bg-surface-hover"
        viewBox="0 0 100 1"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect
          class={item.craftableNow ? "fill-success" : "fill-accent"}
          x="0"
          y="0"
          width={Math.round(item.completeness * 100)}
          height="1"
        ></rect>
      </svg>

      {#if listedParts.length > 0}
        <div class="grid min-w-0 gap-1">
          <span
            class="font-display text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-text-muted"
            >{$tr("mastery.planner.parts")}</span
          >
          <div class="flex min-w-0 flex-wrap gap-1.5">
            {#each listedParts as comp (comp.uniqueName)}
              {@const blueprintHeld = comp.state === "blueprint"}
              <span class="relative" data-part-state={comp.state}>
                <ItemTile
                  tileKey={comp.uniqueName}
                  tone={comp.missing > 0 ? "danger" : "neutral"}
                  imageUrl={comp.imageUrl}
                  auditKey={comp.name}
                  label={itemLabel(comp)}
                  count="{formatNumber(
                    blueprintHeld ? comp.built : comp.owned,
                    $locale,
                  )}/{formatNumber(comp.needed, $locale)}"
                  ariaLabel={$tr("mastery.openComponentDetailsAria", {
                    name: itemLabel(comp) || $tr("mastery.componentFallback"),
                  })}
                  onOpen={() => openRow(comp)}
                />
                {#if blueprintHeld}
                  <span
                    class="absolute top-1 right-1 h-2.5 w-2.5 rounded-full border border-warning-dim bg-warning"
                    role="img"
                    title={$tr("common.blueprintOwnedNotBuilt")}
                    aria-label={$tr("common.blueprintOwnedNotBuilt")}
                  ></span>
                {/if}
              </span>
            {/each}
          </div>
        </div>
      {/if}

      {#if missingMaterials.length > 0}
        <div class="grid min-w-0 gap-1">
          <span
            class="font-display text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-text-muted"
            >{$tr("mastery.planner.itemMaterials")}</span
          >
          <div class="flex flex-wrap gap-1.5">
            {#each shownMaterials as row (row.uniqueName)}
              <button
                type="button"
                class="planner-chip short"
                aria-label={$tr("mastery.openComponentDetailsAria", {
                  name: itemLabel(row) || $tr("mastery.componentFallback"),
                })}
                onclick={() => openRow(row)}
              >
                <span class="min-w-0 truncate">{itemLabel(row)}</span>
                <span class="font-semibold tabular-nums text-text-primary"
                  >{row.owned.toLocaleString($locale)}/{row.needed.toLocaleString($locale)}</span
                >
              </button>
            {/each}
            {#if missingMaterials.length > MATERIAL_CHIP_LIMIT}
              <button
                type="button"
                class="planner-chip neutral"
                aria-expanded={materialsOpen}
                aria-label={$tr("mastery.planner.toggleMaterials", { name: itemLabel(item) })}
                onclick={() => toggleMaterials(item.uniqueName)}
              >
                {materialsOpen
                  ? $tr("common.showFewer")
                  : $tr("common.moreCount", {
                      count: missingMaterials.length - MATERIAL_CHIP_LIMIT,
                    })}
              </button>
            {/if}
          </div>
        </div>
      {/if}

      <span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        {#if item.components.length > 0}
          <span>
            {#if craftable > 0}{$tr("mastery.roadmap.partsOwnedCraftableShort", {
                owned: parts.built,
                craftable,
                total: parts.total,
              })}{:else}{$tr("mastery.roadmap.partsOwnedShort", {
                owned: parts.built,
                total: parts.total,
              })}{/if}
          </span>
        {/if}
        {#if item.credits > 0}
          <span>{$tr("common.credits")}: {item.credits.toLocaleString($locale)}</span>
        {/if}
      </span>
    {/if}
  </div>
{/snippet}

{#if plan.items.length === 0}
  <div
    class="empty-state rounded-[var(--radius-lg)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)]"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <path d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6Z" />
      <path d="M12 14v7" />
    </svg>
    <p class="max-w-[42ch] text-sm">{$tr("mastery.planner.empty")}</p>
  </div>
{:else}
  <div class="grid gap-3">
    <div class="grid gap-2 min-[900px]:grid-cols-2 min-[1400px]:grid-cols-4" data-planner-stats>
      <ThemedPanel className="p-3">
        <span class="block text-xs uppercase tracking-[0.08em] text-text-muted"
          >{$tr("mastery.planner.pinnedTitle")}</span
        >
        <strong class="font-display text-2xl text-text-primary"
          >{plan.items.length.toLocaleString($locale)}</strong
        >
      </ThemedPanel>
      <ThemedPanel className="p-3">
        <span class="block text-xs uppercase tracking-[0.08em] text-text-muted"
          >{$tr("mastery.planner.craftableNow")}</span
        >
        <strong class="font-display text-2xl text-success"
          >{plan.craftableCount.toLocaleString($locale)}</strong
        >
      </ThemedPanel>
      <ThemedPanel className="p-3">
        <span class="block text-xs uppercase tracking-[0.08em] text-text-muted"
          >{$tr("common.mastery")}</span
        >
        <strong class="block truncate font-display text-2xl text-accent"
          >{$tr("mastery.roadmap.xpAmount", { amount: plannedXp.toLocaleString($locale) })}</strong
        >
      </ThemedPanel>
      <ThemedPanel className="p-3">
        <span class="block text-xs uppercase tracking-[0.08em] text-text-muted"
          >{$tr("common.credits")}</span
        >
        <strong class="block truncate font-display text-2xl text-info"
          >{plan.totalCredits.toLocaleString($locale)}</strong
        >
      </ThemedPanel>
    </div>

    <div class="flex flex-wrap items-center justify-end gap-2">
      <span class="text-xs text-text-muted">{$tr("common.sort")}</span>
      <SegmentedControl value={sort} options={sortOptions} onChange={onSort} />
    </div>

    <div
      class="grid gap-2 rounded-[var(--radius-lg)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-3"
      data-planner-totals
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-display text-sm font-semibold text-text-secondary"
          >{$tr("mastery.planner.combinedMaterials")}</span
        >
        <div class="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span>{$tr("mastery.planner.pinnedCount", { count: plan.items.length })}</span>
          {#if hiddenRows > 0}
            <button
              type="button"
              class="rounded-[var(--radius-sm)] border border-[var(--border)] px-1.5 py-0.5 text-text-secondary hover:border-accent-dim hover:text-accent"
              onclick={() => (showCovered = !showCovered)}
            >
              {showCovered
                ? $tr("common.showFewer")
                : $tr("mastery.planner.showAllMaterials", { count: allRowCount })}
            </button>
          {/if}
        </div>
      </div>

      {#if sortedRows.length === 0}
        <p class="text-xs text-text-muted">{$tr("mastery.planner.noMaterialsNeeded")}</p>
      {:else}
        <div class="grid gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,270px),1fr))]">
          {#each sortedRows as row (row.key)}
            {@render materialBar(row)}
          {/each}
        </div>
      {/if}
    </div>

    {#if groups.craftable.length > 0}
      <div class="grid gap-2">
        <span
          class="font-display text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-text-muted"
          >{$tr("mastery.planner.craftableCount", { count: groups.craftable.length })}</span
        >
        <div class="grid gap-2 min-[900px]:grid-cols-2">
          {#each groups.craftable as item (item.uniqueName)}
            {@render plannedCard(item)}
          {/each}
        </div>
      </div>
    {/if}

    {#if groups.remaining.length > 0}
      <div class="grid gap-2">
        <span
          class="font-display text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-text-muted"
          >{$tr("common.inProgress")}</span
        >
        <div class="grid gap-2 min-[900px]:grid-cols-2">
          {#each groups.remaining as item (item.uniqueName)}
            {@render plannedCard(item)}
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .material-bar__fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: color-mix(in oklab, var(--warning) 26%, transparent);
  }
  .material-bar__fill.covered {
    background: color-mix(in oklab, var(--success) 26%, transparent);
  }
  .material-bar__value {
    border-radius: var(--radius-sm);
    padding: 0.125rem 0.25rem;
    line-height: 1.25;
    background: color-mix(in oklab, var(--bg-deep) 55%, transparent);
  }

  .planner-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    max-width: 15rem;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    padding: 0.1rem 0.4rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .planner-chip.short {
    color: color-mix(in oklab, var(--danger) 88%, white);
    border-color: color-mix(in oklab, var(--danger) 40%, transparent);
    background: color-mix(in oklab, var(--danger) 12%, transparent);
  }
  .planner-chip.neutral {
    color: var(--text-secondary);
    border-color: var(--border);
    background: var(--surface-hover);
  }
  .planner-chip.neutral:hover {
    color: var(--accent);
    border-color: var(--accent-dim);
  }

  .planner-badge {
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    padding: 0.02rem 0.3rem;
    font-family: var(--font-display);
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    line-height: 1.3;
  }
  .planner-badge.xp {
    color: color-mix(in oklab, var(--accent) 86%, white);
    border-color: color-mix(in oklab, var(--accent) 42%, transparent);
    background: color-mix(in oklab, var(--accent) 14%, transparent);
  }
  .planner-badge.ready {
    color: color-mix(in oklab, var(--success) 86%, white);
    border-color: color-mix(in oklab, var(--success) 40%, transparent);
    background: color-mix(in oklab, var(--success) 14%, transparent);
  }
</style>
