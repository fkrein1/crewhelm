export function requiredRehearsalCheckName<Check extends { name: string }>(
  checks: readonly Check[],
  index: number,
): Check["name"] {
  const check = checks[index];

  if (check === undefined) {
    throw new Error("Rehearsal check index is out of bounds.");
  }

  return check.name;
}
