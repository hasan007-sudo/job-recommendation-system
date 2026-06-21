// Group 7 — Ranking order and score passthrough
// The candidate filtering and ordering happen in SQL; searchJobs does not re-rank
// or drop rows. These tests verify that the returned array preserves the SQL's
// order and that each JobCard.score equals the score from the raw SQL row.
// (Whether a low/zero-coverage row is excluded is a SQL concern — WHERE
// cov.matched > 0 — and is covered by the pgvector integration suite.)

import { describe, it, expect, beforeEach, type Mock } from "vitest";
import { vi } from "vitest";
import { searchJobs } from "../search";
import { prisma } from "../prisma";
import { embed, toPgVectorLiteral } from "../embeddings";
import { FIXED_VEC, FIXED_VEC_LIT, makeRow, makeMatch } from "./helpers";

vi.mock("../prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("../embeddings", () => ({ embed: vi.fn(), toPgVectorLiteral: vi.fn() }));

const q = () => prisma.$queryRaw as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  (embed as Mock).mockResolvedValue(FIXED_VEC);
  (toPgVectorLiteral as Mock).mockReturnValue(FIXED_VEC_LIT);
});

// Helper: set up role-only mocks so the final SQL call is the 4th call.
function mockRoleOnly(finalRows: ReturnType<typeof makeRow>[]) {
  q()
    .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
    .mockResolvedValueOnce([]) // title trigram
    .mockResolvedValueOnce([]) // title vector
    .mockResolvedValueOnce(finalRows); // final ranking SQL
}

describe("ranking order", () => {
  it("preserves the SQL result order (highest score first, no re-ranking)", async () => {
    // The SQL returns rows already ordered by score DESC. searchJobs must not
    // reorder them during the mapping step.
    mockRoleOnly([
      makeRow({ jobId: "job-a", score: 90 }),
      makeRow({ jobId: "job-b", score: 60 }),
      makeRow({ jobId: "job-c", score: 30 }),
    ]);

    const result = await searchJobs({
      roleText: "Engineer",
      companyText: "",
      skills: [],
      experienceMinYears: null,
      experienceMaxYears: null,
    });

    expect(result[0]!.jobId).toBe("job-a");
    expect(result[1]!.jobId).toBe("job-b");
    expect(result[2]!.jobId).toBe("job-c");
  });

  it("returns rows untouched — does not drop a null-score row", async () => {
    // searchJobs no longer post-filters by score; a row whose blended score is
    // null (no skills/projects criteria applied) still maps through.
    mockRoleOnly([
      makeRow({ jobId: "job-1", score: 70 }),
      makeRow({ jobId: "job-2", score: null, skillsPct: null, projectsPct: null }),
    ]);

    const result = await searchJobs({
      roleText: "Engineer",
      companyText: "",
      skills: [],
      experienceMinYears: null,
      experienceMaxYears: null,
    });

    expect(result).toHaveLength(2);
    expect(result[1]!.jobId).toBe("job-2");
    expect(result[1]!.score).toBeNull();
  });

  it("the score field on each JobCard equals the score from the SQL row", async () => {
    // Verifies the mapping: row.score → card.score (no transformation).
    mockRoleOnly([makeRow({ jobId: "job-1", score: 75 })]);

    const result = await searchJobs({
      roleText: "Engineer",
      companyText: "",
      skills: [],
      experienceMinYears: null,
      experienceMaxYears: null,
    });

    expect(result[0]!.score).toBe(75);
  });
});
