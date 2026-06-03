import type { ParsedRound } from "./rounds";

export type CompanyOption = {
  id: string;
  name: string;
};

export type SkillOption = {
  name: string;
};

// Derived display label from experience years.
export type Seniority = "entry" | "mid" | "senior";

// Returned by POST /api/search — one card per matching job.
export type JobCard = {
  jobId: string;
  jobTitle: string;
  companyName: string;
  seniority: Seniority;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  roundCount: number;
  rounds: ParsedRound[];
  // Headline match % (0–100): equal blend of the available sub-scores below,
  // or null when nothing could be scored.
  score: number | null;
  // Per-criterion sub-scores for the hover breakdown. Each is null when that
  // criterion didn't apply (no skills queried / no projects on the resume).
  skillsPct: number | null;
  projectsPct: number | null;
  // True when the job matched the role-title or company tiers (drives the
  // default sort's precedence over skill-only matches).
  roleOrCompanyMatched: boolean;
  // Job skills covered by the user's skills / the job's total skill count.
  // matchedSkills is null when no skills were queried.
  matchedSkills: number | null;
  totalSkills: number;
};
