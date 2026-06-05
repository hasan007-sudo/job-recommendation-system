// Group 5 — Skills-only search
// Skills bypass the embedding pipeline entirely and are matched via substring LIKE
// in the final ranking SQL. These mocked tests cover the JS-side behaviour:
// no title/company queries run, embed() is never called, and the single final
// SQL result is mapped through verbatim (order preserved).
// The actual skill-coverage scoring and the WHERE cov.matched > 0 exclusion live
// in SQL and are covered by the pgvector integration suite, not here.
//
// $queryRaw call order for skills-only (no roleText, no companyText):
//   CALL 1 → final ranking SQL only (no title or company queries run)

import { describe, it, expect, beforeEach, type Mock } from "vitest";
import { vi } from "vitest";
import { searchJobs } from "../search";
import { prisma } from "../prisma";
import { embed, toPgVectorLiteral } from "../embeddings";
import { FIXED_VEC, FIXED_VEC_LIT, makeRow } from "./helpers";

vi.mock("../prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("../embeddings", () => ({ embed: vi.fn(), toPgVectorLiteral: vi.fn() }));

const q = () => prisma.$queryRaw as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  (embed as Mock).mockResolvedValue(FIXED_VEC);
  (toPgVectorLiteral as Mock).mockReturnValue(FIXED_VEC_LIT);
});

describe("skills-only search", () => {
  it("runs only the final SQL (no title/company queries, no embed) for a skills-only search", async () => {
    // Guard passes because skillNames is non-empty. No title or company queries
    // run — only the final ranking SQL — and embed() is never called. The mapped
    // row carries the SQL-computed skill coverage straight through.
    q().mockResolvedValueOnce([
      makeRow({ matched: 1, required: 1, skillsPct: 100, score: 100 }),
    ]);

    const result = await searchJobs({
      roleText: "",
      companyText: "",
      skillNames: ["React"],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(100);
    expect(result[0]!.matchedSkills).toBe(1);
    expect(result[0]!.totalSkills).toBe(1);
    // embed must NOT be called — no roleText
    expect(embed).not.toHaveBeenCalled();
    // Only 1 DB call (final SQL)
    expect(q()).toHaveBeenCalledTimes(1);
  });

  it("returns [] and makes no DB calls when all skill entries are blank strings", async () => {
    // After trim + filter(Boolean), skillNames becomes [].
    // Combined with no role/company, the guard fires before any query is made.
    const result = await searchJobs({
      roleText: "",
      companyText: "",
      skillNames: ["  ", "", "\t"],
      experienceYears: null,
    });

    expect(result).toEqual([]);
    expect(q()).not.toHaveBeenCalled();
  });

  it("preserves the SQL result order across multiple jobs", async () => {
    // The SQL returns rows already ranked (job-2 above job-1). searchJobs maps them
    // through without reordering, so the array order is preserved.
    q().mockResolvedValueOnce([
      makeRow({ jobId: "job-2", skillsPct: 100, score: 100 }),
      makeRow({ jobId: "job-1", skillsPct: 50, score: 50 }),
    ]);

    const result = await searchJobs({
      roleText: "",
      companyText: "",
      skillNames: ["React", "TypeScript"],
      experienceYears: null,
    });

    expect(result[0]!.jobId).toBe("job-2");
    expect(result[1]!.jobId).toBe("job-1");
  });
});
