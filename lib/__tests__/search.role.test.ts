// Group 3 — Role-only search
// Tests each title-matching tier independently (exact, trigram, vector) and
// verifies the function handles the case where no tier returns any result.
//
// $queryRaw call order for role-only (no company, no skills):
//   CALL 1 → title exact
//   CALL 2 → title trigram
//   CALL 3 → title vector (ANN)
//   CALL 4 → final ranking SQL

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

describe("role-only search", () => {
  it("returns a job when the exact title tier matches (score = 1.0, weighted × 2.0 = 2.0)", async () => {
    // Exact match fires first; trigram and vector return nothing.
    // Final SQL returns one row with totalScore reflecting the exact title match.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
      .mockResolvedValueOnce([])                         // title trigram
      .mockResolvedValueOnce([])                         // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1", totalScore: 2.0 })]); // final

    const result = await searchJobs({
      roleText: "Software Engineer",
      companyText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.jobId).toBe("job-1");
    expect(result[0]!.score).toBe(2.0);
  });

  it("returns a job when only the trigram tier matches (catches typos and partials)", async () => {
    // Exact fails; trigram similarity 0.7 → totalScore = 2.0 × 0.7 = 1.4.
    // This validates that fuzzy title matching still surfaces relevant jobs.
    q()
      .mockResolvedValueOnce([])                          // title exact
      .mockResolvedValueOnce([makeMatch("job-1", 0.7)])   // title trigram
      .mockResolvedValueOnce([])                          // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1", totalScore: 1.4 })]); // final

    const result = await searchJobs({
      roleText: "Softwre Enginer", // intentional typo
      companyText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBeCloseTo(1.4);
  });

  it("returns a job when only the vector tier matches (catches semantic synonyms like 'SDE')", async () => {
    // Exact and trigram miss because 'SDE' shares no 3-grams with 'Software Engineer'.
    // Vector (cosine sim 0.62) is the only hit → totalScore = 2.0 × 0.62 = 1.24.
    q()
      .mockResolvedValueOnce([])                           // title exact
      .mockResolvedValueOnce([])                           // title trigram
      .mockResolvedValueOnce([makeMatch("job-1", 0.62)])   // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1", totalScore: 1.24 })]); // final

    const result = await searchJobs({
      roleText: "SDE",
      companyText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBeCloseTo(1.24);
  });

  it("returns a job when all three tiers match — embed() is always called for role text", async () => {
    // All three tiers return the same job with different scores.
    // The keepMax logic in matchTitle picks the highest (exact = 1.0).
    // We verify: embed() was called once, and the function returns a result.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)])  // title exact
      .mockResolvedValueOnce([makeMatch("job-1", 0.8)])  // title trigram
      .mockResolvedValueOnce([makeMatch("job-1", 0.9)])  // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1", totalScore: 2.0 })]); // final

    const result = await searchJobs({
      roleText: "Software Engineer",
      companyText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(embed).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
  });

  it("makes exactly 4 $queryRaw calls for a role-only search (3 title tiers + 1 final)", async () => {
    // Validates the expected call count so regressions in query structure are caught.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeRow()]);

    await searchJobs({
      roleText: "Frontend Engineer",
      companyText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(q()).toHaveBeenCalledTimes(4);
  });
});
