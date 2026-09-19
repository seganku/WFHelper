import { describe, expect, it } from "vitest";

import { planQuantitySync, runQuantitySync } from "../../../src/lib/marketOrderInventory.js";
import type { ParsedItem } from "../../../src/types/inventory.js";
import type { WfmOrder } from "../../../src/types/market.js";

function order(id: string, overrides: Partial<WfmOrder>): WfmOrder {
  return {
    id,
    orderType: "sell",
    platinum: 42,
    quantity: 1,
    visible: true,
    modRank: null,
    itemId: null,
    itemName: "Trinity Prime Chassis",
    itemUrlName: "trinity_prime_chassis",
    itemThumb: null,
    ...overrides,
  };
}

function owned(amount: number): ParsedItem {
  return { name: "Trinity Prime Chassis", amount } as ParsedItem;
}

/** What syncQuantitiesToInventory hands wfmUpdateOrder, one PATCH per update. */
function patchBodies(plan: ReturnType<typeof planQuantitySync>): Array<Record<string, unknown>> {
  return plan.updates.map((update) => ({ quantity: update.quantity }));
}

describe("market quantity sync", () => {
  it("patches the owned count and nothing else", () => {
    const plan = planQuantitySync([order("a", { quantity: 1, platinum: 42 })], [owned(3)]);
    expect(patchBodies(plan)).toEqual([{ quantity: 3 }]);
    for (const body of patchBodies(plan)) {
      expect(body).not.toHaveProperty("platinum");
    }
  });

  it("patches nothing when the listing already matches the inventory", () => {
    const plan = planQuantitySync([order("a", { quantity: 3 })], [owned(3)]);
    expect(patchBodies(plan)).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it("never patches a quantity below the listing's own perTrade", () => {
    const plan = planQuantitySync(
      [order("bulk", { quantity: 12, perTrade: 6 }), order("small", { quantity: 12, perTrade: 2 })],
      [owned(3)],
    );
    expect(patchBodies(plan)).toEqual([{ quantity: 3 }]);
    expect(plan.updates[0].order.id).toBe("small");
    expect(plan.belowPerTrade).toBe(1);
  });

  it("sends one PATCH per listing, in plan order", async () => {
    const plan = planQuantitySync(
      [order("a", { quantity: 1 }), order("b", { quantity: 1 })],
      [owned(3)],
    );
    const seen: Array<[string, number]> = [];
    const outcome = await runQuantitySync(plan.updates, async (order, quantity) => {
      seen.push([order.id, quantity]);
      return true;
    });
    expect(seen).toEqual([
      ["a", 3],
      ["b", 3],
    ]);
    expect(outcome).toEqual({ sent: 2, remaining: 0 });
  });

  it("stops at the first refusal and reports the listings left undone", async () => {
    const plan = planQuantitySync(
      [order("a", { quantity: 1 }), order("b", { quantity: 1 }), order("c", { quantity: 1 })],
      [owned(3)],
    );
    const seen: string[] = [];
    const outcome = await runQuantitySync(plan.updates, async (order) => {
      seen.push(order.id);
      return order.id !== "b";
    });
    expect(seen).toEqual(["a", "b"]);
    expect(outcome).toEqual({ sent: 1, remaining: 2 });
  });
});
