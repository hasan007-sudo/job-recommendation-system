// Group 7 — Score filtering and ranking order
// Verifies that rows with totalScore = 0 are dropped, that the returned array
// preserves descending score order from the SQL, and that the score field on
// each JobCard matches the totalScore from the raw SQL row.

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

describe("score filtering", () => {
  it("drops rows where totalScore = 0 (matched filter but scored nothing)", async () => {
    // A job can survive the WHERE clause (its id was in titleIds) but still score 0
    // if title weight × 0-score + no other terms = 0. Such rows must be filtered.
    mockRoleOnly([
      makeRow({ jobId: "job-1", totalScore: 2.0 }),
      makeRow({ jobId: "job-2", totalScore: 0 }),
    ]);

    const result = await searchJobs({
      roleText: "Engineer",
      companyText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.jobId).toBe("job-1");
  });

  it("returns [] when every row has totalScore = 0", async () => {
    // All rows are dropped by the post-SQL filter → empty result.
    mockRoleOnly([
      makeRow({ totalScore: 0 }),
      makeRow({ totalScore: 0 }),
    ]);

    const result = await searchJobs({
      roleText: "Engineer",
      companyText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(result).toEqual([]);
  });
});

describe("ranking order", () => {
  it("preserves descending totalScore order from the SQL result (highest score first)", async () => {
    // The SQL returns rows already ordered by totalScore DESC. searchJobs must
    // not reorder them during the mapping step.
    mockRoleOnly([
      makeRow({ jobId: "job-a", totalScore: 5.0 }),
      makeRow({ jobId: "job-b", totalScore: 3.0 }),
      makeRow({ jobId: "job-c", totalScore: 1.5 }),
    ]);

    const result = await searchJobs({
      roleText: "Engineer",
      companyText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(result[0]!.jobId).toBe("job-a");
    expect(result[1]!.jobId).toBe("job-b");
    expect(result[2]!.jobId).toBe("job-c");
  });

  it("the score field on each JobCard equals the totalScore from the SQL row", async () => {
    // Verifies the mapping: row.totalScore → card.score (no transformation).
    mockRoleOnly([makeRow({ jobId: "job-1", totalScore: 3.75 })]);

    const result = await searchJobs({
      roleText: "Engineer",
      companyText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(result[0]!.score).toBe(3.75);
  });
});
