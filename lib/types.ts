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
  score: number;
};
