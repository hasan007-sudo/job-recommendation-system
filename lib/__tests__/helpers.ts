// Shared fixtures and builder helpers used across all search test files.
// Not a test file itself — no describe/it blocks here.

export const FIXED_VEC = new Array(384).fill(0.1) as number[];
export const FIXED_VEC_LIT = `[${FIXED_VEC.join(",")}]`;

// Mirrors the shape that the final ranking $queryRaw returns per row.
export type SearchRowRaw = {
  jobId: string;
  jobTitle: string;
  companyName: string;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  focusRoundPattern: string;
  totalScore: number;
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
    totalScore: 2.0,
    ...overrides,
  };
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
