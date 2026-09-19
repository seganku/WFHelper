<script lang="ts">
  import { onMount } from "svelte";
  import { locale, tr as t, type MessageKey } from "../../lib/i18n.js";
  import { itemLabel } from "../../lib/itemLabel.js";
  import { activeWindow } from "../../lib/format.js";
  import { clockStore } from "../../lib/timers.js";
  import { HUB_NODE } from "../../../config/shared/relayNames.js";
  import { buildParsedItemFromDb } from "../../lib/parsedItemFromDb.js";
  import { buildBaroCatalog, baroBudget } from "../../lib/world/baroPlanner.js";
  import { worldData } from "../../stores/world.js";
  import { itemDb, inventoryData, componentOwnership } from "../../stores/data.js";
  import { activeItem } from "../../stores/modals.js";
  import {
    baroHistory,
    baroHistoryLoading,
    baroHistoryError,
    baroHistoryRetryAt,
    baroHistoryRefreshAt,
    loadBaroHistory,
    baroWishlist,
    baroWishlistFull,
    setBaroWishQuantity,
    baroWishlistAlerts,
    setBaroWishlistAlerts,
  } from "../../stores/baro.js";
  import SearchBox from "../SearchBox.svelte";
  import ItemImage from "../ItemImage.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import BaroLastSeen from "./BaroLastSeen.svelte";

  type Filter = "all" | "current" | "history" | "wishlist";
  const FILTER_KEYS: Record<Filter, MessageKey> = {
    all: "common.all",
    current: "baro.currentVisit",
    history: "baro.recordedItems",
    wishlist: "baro.wishlist",
  };
  const clock = clockStore(30_000);
  let countdownNow = $state(Date.now());
  const nextAttemptAt = $derived(Math.max($baroHistoryRetryAt, $baroHistoryRefreshAt));
  const retrySeconds = $derived(
    Math.max(0, Math.ceil(($baroHistoryRetryAt - countdownNow) / 1000)),
  );
  const refreshSeconds = $derived(Math.max(0, Math.ceil((nextAttemptAt - countdownNow) / 1000)));
  $effect(() => {
    if (nextAttemptAt) countdownNow = Date.now();
  });
  $effect(() => {
    const remaining = nextAttemptAt - countdownNow;
    if (remaining <= 0) return;
    const timer = setTimeout(() => (countdownNow = Date.now()), Math.min(1000, remaining));
    return () => clearTimeout(timer);
  });
  let filter = $state<Filter>("all");
  let search = $state("");
  let unowned = $state(false);
  let selectedVisit = $state("");
  let addSearch = $state("");
  let limit = $state(50);
  const current = $derived($worldData?.voidTrader ?? null);
  const active = $derived(activeWindow(current?.activation, current?.expiry, $clock));
  const catalog = $derived(
    buildBaroCatalog($baroHistory, current, $inventoryData, $itemDb, $baroWishlist, $clock),
  );
  const budget = $derived(baroBudget(catalog, $inventoryData));
  const visits = $derived(
    [...($baroHistory?.visits ?? [])].sort((a, b) => b.activation - a.activation),
  );
  const visit = $derived(visits.find((entry) => entry.id === selectedVisit) ?? null);
  const visitItems = $derived(
    new Map(visit?.items.map((entry) => [entry.uniqueName, entry]) ?? []),
  );
  const coverage = $derived(
    $baroHistory?.coverageStart
      ? new Date($baroHistory.coverageStart).toLocaleDateString($locale)
      : null,
  );
  const filtered = $derived(
    catalog
      .filter((row) => {
        if (filter === "current" && !row.available) return false;
        if (
          filter === "history" &&
          (visit ? !visitItems.has(row.uniqueName) : row.lastSeen === null)
        )
          return false;
        if (filter === "wishlist" && row.quantity === 0) return false;
        if (unowned && $inventoryData && row.owned) return false;
        return row.name
          .toLocaleLowerCase($locale)
          .includes(search.trim().toLocaleLowerCase($locale));
      })
      .sort(
        (a, b) =>
          Number(b.available) - Number(a.available) || a.name.localeCompare(b.name, $locale),
      ),
  );
  const shown = $derived(filtered.slice(0, limit));
  const wishCount = $derived(catalog.reduce((total, row) => total + row.quantity, 0));
  const searchIndex = $derived(
    Object.entries($itemDb)
      .filter(([key]) => key.startsWith("/Lotus/"))
      .map(([key, entry]) => ({
        key,
        entry,
        searchName: itemLabel(entry).toLocaleLowerCase($locale),
      })),
  );
  const candidates = $derived.by(() => {
    const query = addSearch.trim().toLocaleLowerCase($locale);
    if (query.length < 2) return [];
    return searchIndex
      .filter(({ key, searchName }) => !$baroWishlist[key] && searchName.includes(query))
      .slice(0, 12)
      .map(({ key, entry }) => [key, entry] as const);
  });
  onMount(() => {
    void loadBaroHistory();
  });

  function openItem(uniqueName: string): void {
    const entry = $itemDb[uniqueName];
    if (entry) activeItem.set(buildParsedItemFromDb(uniqueName, entry, $componentOwnership));
  }

  async function quantity(uniqueName: string, input: HTMLInputElement): Promise<void> {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(0, Math.min(99, Math.floor(parsed)));
    input.value = String(clamped);
    if (!(await setBaroWishQuantity(uniqueName, clamped)))
      input.value = String($baroWishlist[uniqueName] ?? 0);
  }

  function selectFilter(next: Filter): void {
    filter = next;
    limit = 50;
  }
</script>

<div class="flex flex-col gap-4 pb-4" data-baro-planner>
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h3 class="m-0 font-display text-2xl text-text-heading">{$t("baro.planner")}</h3>
      <p class="mb-0 mt-1 text-sm text-text-secondary">
        {active
          ? $t("baro.currentAt", { location: current?.location || $t("common.unknown") })
          : $t("baro.away")}
      </p>
    </div>
    <button
      type="button"
      class="btn-secondary"
      data-baro-refresh
      disabled={$baroHistoryLoading || refreshSeconds > 0}
      onclick={() => void loadBaroHistory(true)}
      >{$baroHistoryLoading
        ? $t("common.loading")
        : retrySeconds > 0
          ? $t("baro.retryIn", { seconds: retrySeconds })
          : refreshSeconds > 0
            ? $t("baro.refreshIn", { seconds: refreshSeconds })
            : $t("common.refresh")}</button
    >
  </div>
  {#if $baroHistoryError}<p
      class="m-0 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning"
      data-baro-error
      role="status"
    >
      {$baroHistory ? $t("baro.cachedHistory") : $t("baro.historyUnavailable")}
    </p>{/if}
  {#if $baroHistory}
    <p class="m-0 text-xs text-text-muted" data-baro-coverage>
      {coverage ? $t("baro.coverage", { date: coverage }) : $t("baro.coverageEmpty")}
    </p>
  {/if}
  {#if !$inventoryData}<p class="m-0 text-sm text-warning" data-baro-no-inventory>
      {$t("baro.inventoryUnavailable")}
    </p>{/if}
  <ThemedPanel className="flex flex-col gap-3 p-4">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h4 class="m-0 font-display text-lg text-text-heading">{$t("baro.currentBasket")}</h4>
      <span class="text-xs text-text-muted">{$t("baro.wishedQuantity", { count: wishCount })}</span>
    </div>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div class="rounded-lg border border-border p-3" data-baro-budget="ducats">
        <span class="text-xs uppercase text-text-muted">{$t("common.ducats")}</span>
        <p class="mb-1 mt-2 font-display text-2xl text-text-primary">
          {budget.unknownDucats ? $t("common.unknown") : budget.totalDucats.toLocaleString($locale)}
        </p>
        <p class="m-0 text-xs text-text-secondary">
          {$t("baro.balance", {
            value:
              budget.ducats === null ? $t("common.unknown") : budget.ducats.toLocaleString($locale),
          })}
        </p>
        {#if budget.ducatShortfall !== null}<p
            class="mb-0 mt-1 text-xs {budget.ducatShortfall > 0 ? 'text-warning' : 'text-success'}"
          >
            {$t("baro.shortfall", { value: budget.ducatShortfall.toLocaleString($locale) })}
          </p>{/if}
      </div>
      <div class="rounded-lg border border-border p-3" data-baro-budget="credits">
        <span class="text-xs uppercase text-text-muted">{$t("common.credits")}</span>
        <p class="mb-1 mt-2 font-display text-2xl text-text-primary">
          {budget.unknownCredits
            ? $t("common.unknown")
            : budget.totalCredits.toLocaleString($locale)}
        </p>
        <p class="m-0 text-xs text-text-secondary">
          {$t("baro.balance", {
            value:
              budget.credits === null
                ? $t("common.unknown")
                : budget.credits.toLocaleString($locale),
          })}
        </p>
        {#if budget.creditShortfall !== null}<p
            class="mb-0 mt-1 text-xs {budget.creditShortfall > 0 ? 'text-warning' : 'text-success'}"
          >
            {$t("baro.shortfall", { value: budget.creditShortfall.toLocaleString($locale) })}
          </p>{/if}
      </div>
    </div>
    <p class="m-0 text-xs text-text-muted">{$t("baro.budgetScope")}</p>
    {#if budget.unknownCosts > 0}<p class="m-0 text-sm text-warning" data-baro-unknown-costs>
        {$t("baro.unknownCosts", { count: budget.unknownCosts })}
      </p>{/if}
    {#if budget.unavailableItems > 0}<p
        class="m-0 text-sm text-text-secondary"
        data-baro-future-wishes
      >
        {$t("baro.futureWishes", { count: budget.unavailableItems })}
      </p>{/if}
  </ThemedPanel>

  <div class="flex flex-wrap items-center gap-3">
    <div class="filter-tabs flex-wrap">
      {#each Object.entries(FILTER_KEYS) as [key, label]}<button
          type="button"
          class="filter-tab"
          class:active={filter === key}
          aria-pressed={filter === key}
          data-baro-filter={key}
          onclick={() => selectFilter(key as Filter)}>{$t(label)}</button
        >{/each}
    </div>
    <SearchBox
      value={search}
      class="w-64 max-w-full"
      onValueChange={(value) => {
        search = value;
        limit = 50;
      }}
    />
    <label class="flex cursor-pointer items-center gap-2 text-sm text-text-secondary"
      ><input
        type="checkbox"
        data-baro-unowned
        bind:checked={unowned}
        disabled={!$inventoryData}
        onchange={() => (limit = 50)}
      />{$t("baro.unownedOnly")}</label
    >
  </div>
  {#if filter === "history"}
    <div class="flex flex-wrap items-center gap-3">
      <label class="flex items-center gap-2 text-sm text-text-secondary"
        >{$t("baro.recordedVisit")}<select
          class="shared-filter-select"
          bind:value={selectedVisit}
          data-baro-visit
          onchange={() => (limit = 50)}
          ><option value="">{$t("baro.allRecordedVisits")}</option>{#each visits as entry}<option
              value={entry.id}
              >{new Date(entry.activation).toLocaleDateString($locale)}{entry.node
                ? ` · ${HUB_NODE[entry.node] || entry.node}`
                : ""}</option
            >{/each}</select
        ></label
      >
      {#if visit}<span class="text-xs text-text-muted"
          >{$t("baro.visitEnded", { date: new Date(visit.expiry).toLocaleString($locale) })}</span
        >{/if}
    </div>
  {/if}
  <ThemedPanel className="overflow-hidden">
    {#if shown.length === 0}<div class="empty-state">
        <p>{$baroHistoryLoading ? $t("common.loading") : $t("baro.noMatches")}</p>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-sm" data-baro-table>
          <thead
            ><tr
              class="border-b border-border bg-bg-soft text-left text-xs uppercase text-text-muted"
              ><th class="px-4 py-3">{$t("common.item")}</th><th class="px-3 py-3"
                >{$t("baro.historyStatus")}</th
              ><th class="px-3 py-3 text-right">{$t("common.ducats")}</th><th
                class="px-3 py-3 text-right">{$t("common.credits")}</th
              ><th class="px-4 py-3 text-right">{$t("baro.wishQuantity")}</th></tr
            ></thead
          >
          <tbody
            >{#each shown as row, index (row.uniqueName)}
              {#if filter === "wishlist" && (index === 0 || shown[index - 1].available !== row.available)}<tr
                  class="bg-bg-soft"
                  ><th colspan="5" class="px-4 py-2 text-left text-xs uppercase text-text-muted"
                    >{row.available ? $t("baro.availableWishes") : $t("baro.futureWishlist")}</th
                  ></tr
                >{/if}
              {@const recorded =
                filter === "history" && visit ? visitItems.get(row.uniqueName) : null}
              {@const ducats = recorded ? recorded.ducats : row.ducats}
              {@const credits = recorded ? recorded.credits : row.credits}
              <tr
                class="border-b border-border/40 hover:bg-surface-hover"
                data-baro-row={row.uniqueName}
              >
                <td class="px-4 py-3"
                  ><div class="flex min-w-44 items-center gap-3">
                    {#if row.imageUrl}<ItemImage
                        src={row.imageUrl}
                        alt=""
                        auditKey={row.name}
                        cls="!h-12 !w-12 shrink-0"
                      />{:else}<div class="h-12 w-12 shrink-0"></div>{/if}
                    <div class="flex flex-col gap-1" data-baro-name>
                      <button
                        type="button"
                        class="border-0 bg-transparent p-0 text-left text-text-primary enabled:cursor-pointer enabled:hover:text-accent"
                        disabled={!$itemDb[row.uniqueName]}
                        data-baro-open={row.uniqueName}
                        onclick={() => openItem(row.uniqueName)}>{row.name}</button
                      >{#if $inventoryData && row.owned}<span class="text-xs text-success"
                          >{$t("common.owned")}</span
                        >{/if}
                    </div>
                  </div></td
                >
                <td class="px-3 py-3"
                  ><BaroLastSeen
                    uniqueName={row.uniqueName}
                    available={row.available}
                    lastRecorded={row.lastSeen}
                  />{#if recorded || (!row.available && row.lastSeen !== null)}<div
                      class="mt-1 text-xs text-text-muted"
                    >
                      {$t("baro.historicalPrice")}
                    </div>{/if}</td
                >
                <td class="whitespace-nowrap px-3 py-3 text-right tabular-nums text-text-secondary"
                  >{ducats === null ? $t("common.unknown") : ducats.toLocaleString($locale)}</td
                ><td class="whitespace-nowrap px-3 py-3 text-right tabular-nums text-text-secondary"
                  >{credits === null ? $t("common.unknown") : credits.toLocaleString($locale)}</td
                >
                <td class="px-4 py-3 text-right"
                  ><input
                    type="number"
                    min="0"
                    max="99"
                    step="1"
                    class="w-16 rounded border border-border bg-bg-soft px-2 py-1.5 text-right text-text-primary"
                    value={row.quantity}
                    aria-label={$t("baro.quantityFor", { name: row.name })}
                    data-baro-quantity={row.uniqueName}
                    onchange={(event) => quantity(row.uniqueName, event.currentTarget)}
                  /></td
                >
              </tr>
            {/each}</tbody
          >
        </table>
      </div>
      {#if shown.length < filtered.length}<div class="p-3 text-center">
          <button
            type="button"
            class="btn-secondary btn-sm"
            data-baro-show-more
            onclick={() => (limit += 50)}
            >{$t("baro.showMore", { remaining: filtered.length - shown.length })}</button
          >
        </div>{/if}
    {/if}
  </ThemedPanel>
  <ThemedPanel className="flex flex-col gap-3 p-4">
    <h4 class="m-0 font-display text-lg text-text-heading">{$t("baro.addWish")}</h4>
    <label class="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
      <input
        type="checkbox"
        checked={$baroWishlistAlerts}
        data-baro-arrival-alerts
        onchange={(event) => setBaroWishlistAlerts(event.currentTarget.checked)}
      />
      {$t("baro.wishlistAlerts")}
    </label>
    <p class="m-0 text-xs text-text-muted">{$t("baro.addWishHint")}</p>
    {#if $baroWishlistFull}<p
        class="m-0 text-sm text-warning"
        role="status"
        data-baro-wishlist-full
      >
        {$t("baro.wishlistFull")}
      </p>{/if}
    <SearchBox
      value={addSearch}
      class="w-96 max-w-full"
      onValueChange={(value) => (addSearch = value)}
    />
    <div class="grid grid-cols-1 gap-2 lg:grid-cols-2" data-baro-add-results>
      {#each candidates as [uniqueName, entry]}<div
          class="flex items-center justify-between gap-3 rounded border border-border p-2"
        >
          <span class="text-sm text-text-primary">{itemLabel(entry)}</span><button
            type="button"
            class="btn-secondary btn-sm"
            data-baro-add={uniqueName}
            disabled={$baroWishlistFull}
            aria-label={$t("baro.addItem", { name: itemLabel(entry) })}
            onclick={() => setBaroWishQuantity(uniqueName, 1)}>{$t("settings.fissureAdd")}</button
          >
        </div>{/each}
    </div>
  </ThemedPanel>
</div>
