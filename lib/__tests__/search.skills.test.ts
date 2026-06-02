// Group 5 — Skills-only search
// Skills bypass the embedding pipeline entirely and are matched via substring LIKE
// in the final ranking SQL. Tests verify: literal match, multi-skill scoring,
// zero-match filtering, and blank-string stripping.
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
  it("returns a job when a single skill has a literal substring match in requiredSkills", async () => {
    // Guard passes because skillNames is non-empty.
    // No title or company queries run — only the final ranking SQL.
    // The SQL mock simulates a job that matched 1 skill (totalScore = 1.0 × 1 = 1.0).
    q().mockResolvedValueOnce([makeRow({ totalScore: 1.0 })]);

    const result = await searchJobs({
      roleText: "",
      companyText: "",
      skillNames: ["React"],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(1.0);
    // embed must NOT be called — no roleText
    expect(embed).not.toHaveBeenCalled();
    // Only 1 DB call (final SQL)
    expect(q()).toHaveBeenCalledTimes(1);
  });

  it("scores higher when multiple skills match (each matched skill adds 1.0)", async () => {
    // Two skills both found in requiredSkills → totalScore = 1.0 × 2 = 2.0.
    // Verifies that skill count (not presence) drives the score.
    q().mockResolvedValueOnce([makeRow({ totalScore: 2.0 })]);

    const result = await searchJobs({
      roleText: "",
      companyText: "",
      skillNames: ["React", "Node.js"],
      experienceYears: null,
    });

    expect(result[0]!.score).toBe(2.0);
  });

  it("returns [] when no job's requiredSkills contain the typed skill (totalScore = 0 filtered out)", async () => {
    // The guard passes (skills non-empty), the SQL runs, but the mock returns a row
    // with totalScore = 0 (no literal match). The post-SQL filter drops it.
    // This simulates searching for a skill like "K8s" when all jobs say "Kubernetes".
    q().mockResolvedValueOnce([makeRow({ totalScore: 0 })]);

    const result = await searchJobs({
      roleText: "",
      companyText: "",
      skillNames: ["K8s"],
      experienceYears: null,
    });

    expect(result).toEqual([]);
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

  it("returns multiple jobs ordered by descending skill-match count", async () => {
    // Two jobs: job-2 matched both skills (score 2.0), job-1 matched one (score 1.0).
    // The mock returns them already ordered by totalScore DESC (as the SQL would).
    q().mockResolvedValueOnce([
      makeRow({ jobId: "job-2", totalScore: 2.0 }),
      makeRow({ jobId: "job-1", totalScore: 1.0 }),
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
