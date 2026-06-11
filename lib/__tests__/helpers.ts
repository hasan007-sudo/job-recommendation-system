// Shared fixtures and builder helpers used across all search test files.
// Not a test file itself — no describe/it blocks here.

export const FIXED_VEC = new Array(512).fill(0.1) as number[];
export const FIXED_VEC_LIT = `[${FIXED_VEC.join(",")}]`;

// Mirrors the shape that the final ranking $queryRaw returns per row
// (see ScoreRow in ../search.ts). The sub-scores and 65/35 blend are computed
// in SQL, so mocked rows just carry whatever values the test needs; searchJobs
// maps them through verbatim (roleOrCompanyMatched = tier < 2).
export type SearchRowRaw = {
  jobId: string;
  jobTitle: string;
  companyName: string;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  focusRoundPattern: string;
  covered: number;
  required: number;
  skillsPct: number | null;
  projectsPct: number | null;
  score: number | null;
  tier: number;
};

// Builds a minimal valid SearchRowRaw; override any field you care about.
export function makeRow(overrides: Partial<SearchRowRaw> = {}): SearchRowRaw {
  return {
    jobId: "job-1",
    jobTitle: "Software Engineer",
    companyName: "Acme Corp",
    experienceMinYears: 2,
    experienceMaxYears: 5,
    focusRoundPattern: "Opening/Screening+Technical/Role Skills",
    covered: 1,
    required: 2,
    skillsPct: 50,
    projectsPct: null,
    score: 50,
    tier: 1,
    ...overrides,
  };
}

// Shorthand for a covered-skill catalog row (resolveCoveredSkillIds result).
export function makeSkillId(id: string) {
  return { id };
}

// Shorthand for a skill-path candidate row (matchSkillJobIds result).
export function makeSkillJob(jobId: string) {
  return { jobId };
}

// Shorthand for a title-tier match row (exact, trigram, or vector result).
export function makeMatch(id: string, score: number) {
  return { id, score };
}

// Shorthand for a company exact-match row.
export function makeCompanyExact(id: string) {
  return { id };
}

// Shorthand for a company trigram row.
export function makeCompanyTrigram(id: string, score: number) {
  return { id, score };
}
