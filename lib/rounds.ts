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

// Fixed 4-round interview structure. Each round carries its own key competencies,
// stored as ';'-separated topics on the Job (precomputed in JobPostingsV2).
export type Round = { position: number; slug: string; title: string; competencies: string[] };

const FIXED_ROUNDS = [
  { slug: "screening", title: "Screening", key: "roundScreening" },
  { slug: "behavioural", title: "Behavioural", key: "roundBehavioural" },
  { slug: "technical", title: "Technical", key: "roundTechnical" },
  { slug: "culture_fit", title: "Culture fit", key: "roundCultureFit" },
] as const;

type RoundFields = {
  roundScreening: string | null;
  roundBehavioural: string | null;
  roundTechnical: string | null;
  roundCultureFit: string | null;
};

export function buildRounds(job: RoundFields): Round[] {
  return FIXED_ROUNDS.map((round, i) => ({
    position: i + 1,
    slug: round.slug,
    title: round.title,
    competencies: (job[round.key] ?? "")
      .split(";")
      .map((topic) => topic.trim())
      .filter(Boolean),
  }));
}
