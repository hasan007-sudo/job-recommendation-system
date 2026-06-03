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

// Tier-colored pill (background + dot + title-case label) for the job detail header.
export function matchPill(
  percent: number | undefined,
): { label: string; pill: string; dot: string } | null {
  if (percent === undefined) return null;
  if (percent >= 80)
    return { label: "Strong Match", pill: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" };
  if (percent >= 60)
    return { label: "Good Match", pill: "bg-indigo-50 text-indigo-700", dot: "bg-indigo-500" };
  return { label: "Fair Match", pill: "bg-amber-50 text-amber-700", dot: "bg-amber-500" };
}

// Up-to-two-letter monogram for a company logo mark.
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0] + parts[1]![0]).toUpperCase();
}
