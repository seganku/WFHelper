<script lang="ts">
  import { onMount } from "svelte";
  import { nextDailyResetUtc, nextWeeklyResetUtc, parseIsoDate, timeTo } from "../../lib/format.js";
  import { tr } from "../../lib/i18n.js";
  import {
    loadTracker,
    trackerCount,
    trackerList,
    trackerPeriodKey,
  } from "../../lib/world/dailies.js";
  import { autoTrackerState } from "../../lib/world/dailiesAuto.js";
  import { trackerExpiries, trackerLive } from "../../lib/world/dailiesLive.js";
  import { inventoryData, inventoryModifiedAt } from "../../stores/data.js";
  import { worldData } from "../../stores/world.js";

  const { onOpenDailies, nowMs }: { onOpenDailies: () => void; nowMs: number } = $props();
  const highlighted = new Set([
    "archonHunt",
    "circuitNormal",
    "circuitSteelPath",
    "netracells",
    "steelPathHonors",
  ]);
  let tracker = $state(loadTracker());
  const now = $derived(new Date(nowMs));
  const expiries = $derived(trackerExpiries($worldData));
  const auto = $derived(autoTrackerState($inventoryData, $worldData, nowMs, $inventoryModifiedAt));
  const rows = $derived(
    trackerList(tracker)
      .filter((task) => highlighted.has(task.id) && !tracker.hidden.includes(task.id))
      .map((task) => {
        const live = trackerLive(task.id, $worldData, $tr, nowMs);
        const period = trackerPeriodKey(task.period, now, expiries);
        const count = Math.max(
          trackerCount(tracker, task.id, period, nowMs),
          auto[task.id]?.count ?? 0,
        );
        const detail = auto[task.id]?.detail;
        return {
          ...task,
          count: Math.min(task.target, count),
          done: count >= task.target,
          detail: live.detail ?? (detail ? $tr(detail.key, detail.params) : ""),
          expiry:
            parseIsoDate(live.expiry) ??
            (task.period === "daily"
              ? nextDailyResetUtc(now)
              : task.period === "weekly"
                ? nextWeeklyResetUtc(now)
                : null),
        };
      }),
  );

  onMount(() => {
    const refresh = () => (tracker = loadTracker());
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  });
</script>

<section data-world-week-overview>
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <h3 class="m-0 text-base font-semibold text-text-primary">{$tr("world.thisWeek")}</h3>
    <button
      type="button"
      class="btn-secondary btn-sm"
      data-world-open-dailies
      onclick={onOpenDailies}
    >
      {$tr("world.openDailies")}
    </button>
  </div>
  <div class="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-secondary">
    <span>{$tr("world.dailyReset")}: {timeTo(nextDailyResetUtc(now), nowMs)}</span>
    <span>{$tr("world.weeklyResets")}: {timeTo(nextWeeklyResetUtc(now), nowMs)}</span>
  </div>
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
    {#each rows as row (row.id)}
      <!-- A stretched button centres its content block (UA auto margins). -->
      <button
        type="button"
        class="flex min-w-0 flex-col rounded-lg border border-border bg-surface-card p-3 text-left transition-colors hover:border-accent/50"
        data-world-week-task={row.id}
        data-world-task-done={row.done}
        onclick={onOpenDailies}
      >
        <div class="flex items-start justify-between gap-2">
          <span class="text-sm font-semibold text-text-primary"
            >{row.labelKey ? $tr(row.labelKey) : row.label}</span
          >
          <span
            class="shrink-0 text-xs tabular-nums {row.done
              ? 'text-success'
              : 'text-text-secondary'}"
            data-world-task-progress
          >
            {row.count}/{row.target}
          </span>
        </div>
        {#if row.detail}
          <p class="mt-1.5 mb-0 text-xs text-text-secondary">{row.detail}</p>
        {/if}
        {#if row.expiry}
          <p class="mt-2 mb-0 text-xs text-text-muted">
            {$tr("dailies.resetsIn", { time: timeTo(row.expiry, nowMs) })}
          </p>
        {/if}
      </button>
    {/each}
  </div>
</section>
