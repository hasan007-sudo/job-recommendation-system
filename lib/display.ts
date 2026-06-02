// Shared presentation helpers used by the job list and job detail pages.

export function formatExperience(
  min: number | null,
  max: number | null,
): string | null {
  if (min === null && max === null) return null;
  if (min !== null && max !== null) return `${min}–${max} Years`;
  if (min !== null) return `${min}+ Years`;
  return `up to ${max} Years`;
}

export function tierFor(
  percent: number | undefined,
): { label: string; color: string } | null {
  if (percent === undefined) return null;
  if (percent >= 80) return { label: "STRONG MATCH", color: "text-emerald-500" };
  if (percent >= 60) return { label: "GOOD MATCH", color: "text-indigo-500" };
  return { label: "FAIR MATCH", color: "text-amber-500" };
}
