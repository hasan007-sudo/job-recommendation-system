// Parse the scraped focus_round_pattern into an ordered round list at read time.
// Closed 7-segment vocabulary (from the source data). Unknown segments fall back to "Other".

const SEGMENTS: Record<string, { slug: string; title: string }> = {
  "Opening/Screening": { slug: "opening", title: "Opening / Screening" },
  "Technical/Role Skills": { slug: "technical", title: "Technical / Role Skills" },
  "System Design/Architecture": { slug: "system_design", title: "System Design / Architecture" },
  "Behavioral/SJT": { slug: "behavioral", title: "Behavioral / SJT" },
  "Domain/Business": { slug: "domain", title: "Domain / Business" },
  "Final/Culture Fit": { slug: "final", title: "Final / Culture Fit" },
  Other: { slug: "other", title: "Other" },
};

export type ParsedRound = { position: number; slug: string; title: string };

export function parseRounds(pattern: string | null): ParsedRound[] {
  if (!pattern) return [];
  return pattern
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((seg, i) => {
      const mapped = SEGMENTS[seg] ?? { slug: "other", title: seg };
      return { position: i + 1, slug: mapped.slug, title: mapped.title };
    });
}
