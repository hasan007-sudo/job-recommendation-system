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
  // Skill-coverage match % (0–100), or null when no skills were queried.
  score: number | null;
  // Job skills covered by the user's skills / the job's total skill count.
  // matchedSkills is null when no skills were queried.
  matchedSkills: number | null;
  totalSkills: number;
};
