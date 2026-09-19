<script lang="ts">
  import AnalysisEmpty from "./AnalysisEmpty.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import { locale, tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import { formatPlat, itemKeyBase, type ItemRollup } from "../../lib/stats/tradeAnalytics.js";
  import type { AnalyticsItemLink } from "../../lib/stats/analyticsItemLink.js";

  interface Props {
    titleKey: MessageKey;
    rows: ItemRollup[];
    side: "sold" | "bought";
    itemLink: AnalyticsItemLink;
  }

  let { titleKey, rows, side, itemLink }: Props = $props();

  const max = $derived(rows.reduce((m, r) => Math.max(m, r.platinum), 0));
  const barClass = $derived(side === "sold" ? "bg-success" : "bg-danger");
</script>

<ThemedPanel className="flex min-w-0 flex-col p-3">
  <div class="flex min-w-0 flex-col gap-2" data-analysis-top-items={side}>
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {$tr(titleKey)}
      </span>
      <span class="text-[0.65rem] text-text-muted">{$tr("analysis.allocationNote")}</span>
    </div>

    {#if rows.length === 0}
      <AnalysisEmpty messageKey="analysis.noItems" />
    {:else}
      {#snippet rowBody(row: ItemRollup)}
        <div class="flex min-w-0 items-baseline justify-between gap-2">
          <span class="flex min-w-0 items-baseline gap-1.5">
            <span class="truncate text-sm text-text-primary" title={row.name}>{row.name}</span>
            {#if row.secondary}
              <span class="truncate text-[0.65rem] text-text-muted">{row.secondary}</span>
            {/if}
            {#if row.rank != null}
              <span
                class="shrink-0 text-[0.65rem] text-text-muted"
                data-analysis-item-rank={row.rank}
              >
                {$tr("browse.rankValue", { value: row.rank })}
              </span>
            {/if}
          </span>
          <span class="shrink-0 font-semibold tabular-nums text-text-primary">
            {formatPlat(row.platinum, $locale)}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <!-- Spans: the row renders inside a button, which takes phrasing content only. -->
          <span class="block h-1 min-w-0 flex-1 rounded-full bg-[color:var(--ui-panel-border)]">
            <span
              class="block h-full rounded-full {barClass} opacity-75"
              style="width: {max > 0 ? Math.max(2, (row.platinum / max) * 100) : 0}%"
            ></span>
          </span>
          <span class="shrink-0 text-[0.65rem] tabular-nums text-text-muted">
            {$tr("analysis.unitsAndAvg", {
              units: row.units,
              avg: row.avgUnitPlat == null ? "-" : formatPlat(row.avgUnitPlat, $locale),
            })}
          </span>
        </div>
      {/snippet}

      <ol class="m-0 flex list-none flex-col gap-1.5 p-0">
        {#each rows as row (row.key)}
          {@const link = itemLink.resolve(itemKeyBase(row.key), row.name)}
          <li class="min-w-0" data-analysis-item-row={row.key}>
            {#if link}
              <button
                type="button"
                class="flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-[var(--radius-md)] border-0 bg-transparent p-0 text-left text-inherit hover:bg-bg-raised"
                aria-label={$tr("common.openDetailsFor", { name: row.name })}
                onclick={() => itemLink.open(link)}
              >
                {@render rowBody(row)}
              </button>
            {:else}
              <div class="flex min-w-0 flex-col gap-1">{@render rowBody(row)}</div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</ThemedPanel>
