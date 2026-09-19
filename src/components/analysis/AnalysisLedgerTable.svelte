<script lang="ts">
  import { untrack } from "svelte";
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedInput from "../ThemedInput.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import ThemedSelect from "../ThemedSelect.svelte";
  // Aliased: a store named `tr` makes svelte-check flag every <tr> row as a lowercase component.
  import { locale, tr as t } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import {
    formatPlat,
    itemKey,
    itemKeyBase,
    tradeItemLabel,
  } from "../../lib/stats/tradeAnalytics.js";
  import type { AnalyticsItemLink } from "../../lib/stats/analyticsItemLink.js";
  import type { LedgerPage } from "../../../config/shared/tradeLedgerTypes.js";
  import type { TradeEvent, TradeItem, TradeType } from "../../types/ipc.js";

  interface Props {
    page: LedgerPage | null;
    loading: boolean;
    search: string;
    typeFilter: TradeType | "all";
    offset: number;
    limit: number;
    itemLink: AnalyticsItemLink;
    onSearch: (value: string) => void;
    onTypeFilter: (value: TradeType | "all") => void;
    onOffset: (value: number) => void;
    onEdit: (event: TradeEvent) => void;
  }

  let {
    page,
    loading,
    search,
    typeFilter,
    offset,
    limit,
    itemLink,
    onSearch,
    onTypeFilter,
    onOffset,
    onEdit,
  }: Props = $props();

  let searchValue = $state(untrack(() => search));
  let typeValue = $state<TradeType | "all">(untrack(() => typeFilter));

  $effect(() => {
    if (typeValue !== typeFilter) onTypeFilter(typeValue);
  });

  const TYPE_KEYS: Record<TradeType, MessageKey> = {
    sale: "stats.filterSale",
    purchase: "stats.filterPurchase",
    trade: "stats.filterTrade",
  };

  function sourceKey(source: string | undefined): MessageKey {
    if (source === "gdpr") return "analysis.source.gdpr";
    return "common.live";
  }

  const rows = $derived(page?.events ?? []);
  const total = $derived(page?.total ?? 0);
  const first = $derived(total === 0 ? 0 : offset + 1);
  const last = $derived(Math.min(offset + rows.length, total));
  const canPrev = $derived(offset > 0);
  const canNext = $derived(offset + limit < total);

  // A helper that reads $t on its own is not reactive, because Svelte wraps template calls in untrack.
  const countedItemLabel = $derived.by(() => {
    const translate = $t;
    return (item: TradeItem): string => {
      const label = tradeItemLabel(item);
      const qualifier =
        label.secondary ??
        (label.rank == null ? null : translate("browse.rankValue", { value: label.rank }));
      const name = qualifier ? `${label.primary} (${qualifier})` : label.primary || "?";
      return item.count > 1 ? `${item.count}x ${name}` : name;
    };
  });

  function dayLabel(iso: string, loc: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(loc, { year: "numeric", month: "short", day: "numeric" });
  }

  function typeTone(type: TradeType): string {
    if (type === "sale") return "text-success";
    if (type === "purchase") return "text-danger";
    return "text-text-secondary";
  }
</script>

<ThemedPanel className="flex min-h-0 min-w-0 flex-1 flex-col p-3">
  <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2" data-analysis-table>
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {$t("analysis.ledger")}
      </span>
      <ThemedInput
        bind:value={searchValue}
        placeholder={$t("analysis.searchPlaceholder")}
        className="min-w-[14rem] flex-1 !py-1 text-xs"
        searchFocusTarget
        onInput={() => onSearch(String(searchValue))}
      />
      <ThemedSelect bind:value={typeValue} className="h-7">
        <option value="all">{$t("common.all")}</option>
        <option value="sale">{$t("stats.filterSale")}</option>
        <option value="purchase">{$t("stats.filterPurchase")}</option>
        <option value="trade">{$t("stats.filterTrade")}</option>
      </ThemedSelect>
      <span class="ml-auto text-xs tabular-nums text-text-muted" data-analysis-table-count>
        {$t("analysis.rowsRange", { first, last, total })}
      </span>
      <ThemedButton size="compact" disabled={!canPrev} onClick={() => onOffset(offset - limit)}>
        {$t("analysis.prevPage")}
      </ThemedButton>
      <ThemedButton size="compact" disabled={!canNext} onClick={() => onOffset(offset + limit)}>
        {$t("common.next")}
      </ThemedButton>
    </div>

    {#if page && page.unreadableYears.length > 0}
      <p class="m-0 text-xs text-warning" data-analysis-unreadable>
        {$t("analysis.unreadableYears", { years: page.unreadableYears.join(", ") })}
      </p>
    {/if}

    {#if loading}
      <p class="m-0 py-6 text-center text-sm text-text-muted">{$t("common.loading")}</p>
    {:else if rows.length === 0}
      <p class="m-0 py-6 text-center text-sm text-text-muted" data-analysis-table-empty>
        {$t("analysis.noRows")}
      </p>
    {:else}
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="w-full border-collapse text-sm">
          <thead class="sticky top-0 z-10 bg-[var(--ui-panel-bg)]">
            <tr class="text-left text-[0.65rem] uppercase tracking-wide text-text-muted">
              <th class="whitespace-nowrap px-2 py-1 font-semibold">{$t("arbi.col.date")}</th>
              <th class="whitespace-nowrap px-2 py-1 font-semibold">{$t("common.type")}</th>
              <th class="px-2 py-1 font-semibold">{$t("common.item")}</th>
              <th class="whitespace-nowrap px-2 py-1 font-semibold">
                {$t("analysis.colPartner")}
              </th>
              <th class="whitespace-nowrap px-2 py-1 text-right font-semibold">
                {$t("common.platinum")}
              </th>
              <th class="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {#each rows as event (event.id)}
              {@const items = event.items ?? []}
              <tr
                class="border-t border-[color:var(--ui-panel-border)] align-top hover:bg-bg-raised"
                data-analysis-row={event.id}
              >
                <td class="whitespace-nowrap px-2 py-1.5 text-xs tabular-nums text-text-muted">
                  {dayLabel(event.date, $locale)}
                </td>
                <td class="whitespace-nowrap px-2 py-1.5 text-xs {typeTone(event.type)}">
                  {$t(TYPE_KEYS[event.type])}
                </td>
                <td class="max-w-[24rem] px-2 py-1.5 text-xs text-text-primary">
                  <span class="line-clamp-2">
                    {#if items.length === 0}
                      -
                    {:else}
                      {#each items as item, index (index)}
                        {@const link = itemLink.resolve(
                          itemKeyBase(itemKey(item)),
                          tradeItemLabel(item).primary,
                        )}
                        <!-- Svelte trims the space after a bare comma, so a margin makes the gap. -->
                        {#if index > 0}<span class="mr-1">,</span>{/if}
                        {#if link}
                          <button
                            type="button"
                            class="inline cursor-pointer border-0 bg-transparent p-0 text-left text-inherit hover:underline"
                            aria-label={$t("common.openDetailsFor", {
                              name: countedItemLabel(item),
                            })}
                            onclick={() => itemLink.open(link)}
                          >
                            {countedItemLabel(item)}
                          </button>
                        {:else}
                          <span>{countedItemLabel(item)}</span>
                        {/if}
                      {/each}
                    {/if}
                  </span>
                </td>
                <td class="max-w-[10rem] truncate px-2 py-1.5 text-xs text-text-secondary">
                  {event.partner || "-"}
                </td>
                <td class="whitespace-nowrap px-2 py-1.5 text-right text-xs tabular-nums">
                  {formatPlat(event.platChange, $locale)}
                </td>
                <td class="whitespace-nowrap px-2 py-1.5 text-right">
                  <span class="flex items-center justify-end gap-1">
                    {#if event.source && event.source !== "live"}
                      <span class="text-[0.6rem] uppercase tracking-wide text-text-muted">
                        {$t(sourceKey(event.source))}
                      </span>
                    {/if}
                    {#if event.editedAt}
                      <span class="text-[0.6rem] uppercase tracking-wide text-accent">
                        {$t("analysis.edited")}
                      </span>
                    {/if}
                    <ThemedButton size="compact" onClick={() => onEdit(event)}>
                      {$t("market.edit")}
                    </ThemedButton>
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</ThemedPanel>
