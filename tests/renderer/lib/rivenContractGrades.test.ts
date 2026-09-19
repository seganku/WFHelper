import { describe, expect, it } from "vitest";

import { contractIdsToGrade, mergeContractGrades } from "../../../src/lib/rivenContractGrades.js";
import type { RivenContractGrade } from "../../../src/types/ipc.js";

function graded(attributeGrade: string): RivenContractGrade {
  return { overallGrade: "A", attributeGrade, stats: [{ grade: "A", rollFloat: 0.8 }] };
}

describe("mergeContractGrades", () => {
  it("keeps an answer computed without the sheet, but marks it provisional", () => {
    const merged = mergeContractGrades(["a", "b"], [graded("?"), graded("?")], false);

    expect(merged.entries).toEqual([
      ["a", graded("?")],
      ["b", graded("?")],
    ]);
    expect(merged.provisional).toEqual(["a", "b"]);
    expect(merged.settled).toEqual([]);
  });

  it("settles every answer once the sheet has spoken", () => {
    const merged = mergeContractGrades(["a", "b"], [graded("Great"), graded("?")], true);

    expect(merged.provisional).toEqual([]);
    expect(merged.settled).toEqual(["a", "b"]);
  });

  it("settles a weapon the grader could not resolve even without the sheet", () => {
    const merged = mergeContractGrades(["a", "b"], [null, graded("?")], false);

    expect(merged.provisional).toEqual(["b"]);
    expect(merged.settled).toEqual(["a"]);
  });

  it("leaves a slot the grader did not answer untouched", () => {
    const merged = mergeContractGrades(["a", "b", "c"], [graded("Great")], true);

    expect(merged.entries).toEqual([["a", graded("Great")]]);
    expect(merged.settled).toEqual(["a"]);
  });
});

describe("contractIdsToGrade", () => {
  const ids = ["a", "b", "c", "d"];
  const byId = new Map<string, RivenContractGrade | null>([
    ["a", graded("Great")],
    ["b", graded("?")],
    ["c", null],
  ]);

  it("asks for the ungraded and for the ones the sheet still owes", () => {
    expect(contractIdsToGrade(ids, byId, new Set(["b"]), new Set())).toEqual(["b", "d"]);
  });

  it("does not ask twice while a request is in flight", () => {
    expect(contractIdsToGrade(ids, byId, new Set(["b"]), new Set(["b", "d"]))).toEqual([]);
  });

  it("asks for nothing once every contract is settled", () => {
    expect(contractIdsToGrade(["a", "c"], byId, new Set(), new Set())).toEqual([]);
  });
});
