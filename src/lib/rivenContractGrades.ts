import type { RivenContractGrade } from "../types/ipc.js";

interface ContractGradeMerge {
  entries: [string, RivenContractGrade | null][];
  provisional: string[];
  settled: string[];
}

export function mergeContractGrades(
  ids: string[],
  grades: (RivenContractGrade | null)[],
  sheetReady: boolean,
): ContractGradeMerge {
  const answered = ids.slice(0, grades.length);
  const entries = answered.map((id, index): [string, RivenContractGrade | null] => [
    id,
    grades[index],
  ]);
  const waits = (grade: RivenContractGrade | null): boolean =>
    !sheetReady && grade != null && grade.attributeGrade === "?";
  return {
    entries,
    provisional: entries.filter(([, grade]) => waits(grade)).map(([id]) => id),
    settled: entries.filter(([, grade]) => !waits(grade)).map(([id]) => id),
  };
}

export function contractIdsToGrade(
  ids: string[],
  graded: ReadonlyMap<string, RivenContractGrade | null>,
  provisional: ReadonlySet<string>,
  pending: ReadonlySet<string>,
): string[] {
  return ids.filter((id) => (!graded.has(id) || provisional.has(id)) && !pending.has(id));
}
