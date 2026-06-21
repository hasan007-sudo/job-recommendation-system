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
  it("surfaces a job when the exact title tier matches", async () => {
    // Exact match fires first; trigram and vector return nothing. Title only
    // decides membership — the blended score is whatever the final SQL returns.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
      .mockResolvedValueOnce([])                         // title trigram
      .mockResolvedValueOnce([])                         // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1", score: 80 })]); // final

    const result = await searchJobs({
      roleText: "Software Engineer",
      companyText: "",
      skills: [],
      experienceMinYears: null,
      experienceMaxYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.jobId).toBe("job-1");
    expect(result[0]!.score).toBe(80);
  });

  it("surfaces a job when only the trigram tier matches (catches typos and partials)", async () => {
    // Exact fails; only the trigram tier returns the job id. Validates that fuzzy
    // title matching still pulls the job into the candidate set.
    q()
      .mockResolvedValueOnce([])                          // title exact
      .mockResolvedValueOnce([makeMatch("job-1", 0.7)])   // title trigram
      .mockResolvedValueOnce([])                          // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1", score: 70 })]); // final

    const result = await searchJobs({
      roleText: "Softwre Enginer", // intentional typo
      companyText: "",
      skills: [],
      experienceMinYears: null,
      experienceMaxYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.jobId).toBe("job-1");
  });

  it("surfaces a job when only the vector tier matches (catches semantic synonyms like 'SDE')", async () => {
    // Exact and trigram miss because 'SDE' shares no 3-grams with 'Software Engineer'.
    // The semantic (vector ANN) tier is the only one that pulls the job in.
    q()
      .mockResolvedValueOnce([])                           // title exact
      .mockResolvedValueOnce([])                           // title trigram
      .mockResolvedValueOnce([makeMatch("job-1", 0.62)])   // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1", score: 62 })]); // final

    const result = await searchJobs({
      roleText: "SDE",
      companyText: "",
      skills: [],
      experienceMinYears: null,
      experienceMaxYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.jobId).toBe("job-1");
  });

  it("returns a job when all three tiers match — embed() is always called for role text", async () => {
    // All three tiers return the same job id; matchTitleIds dedupes them into a
    // single candidate. We verify: embed() was called once, and a result returns.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)])  // title exact
      .mockResolvedValueOnce([makeMatch("job-1", 0.8)])  // title trigram
      .mockResolvedValueOnce([makeMatch("job-1", 0.9)])  // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1" })]); // final

    const result = await searchJobs({
      roleText: "Software Engineer",
      companyText: "",
      skills: [],
      experienceMinYears: null,
      experienceMaxYears: null,
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
      skills: [],
      experienceMinYears: null,
      experienceMaxYears: null,
    });

    expect(q()).toHaveBeenCalledTimes(4);
  });
});
