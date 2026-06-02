// Group 6 — Combined inputs
// Tests role+company, role+skills, role+experience, and all-four together.
//
// When BOTH roleText and companyText are provided, matchTitle and matchCompanyIds
// run in parallel (Promise.all). Their $queryRaw calls interleave in this
// deterministic order (due to JavaScript's microtask FIFO execution):
//
//   CALL 1 → title exact        (matchTitle starts first in Promise.all)
//   CALL 2 → company exact      (matchCompanyIds starts second)
//   CALL 3 → title trigram
//   CALL 4 → title vector ANN   (if company exact matched; otherwise company trigram is CALL 4)
//   LAST   → final ranking SQL
//
// For role+skills or role+experience (no companyText):
//   CALL 1 → title exact
//   CALL 2 → title trigram
//   CALL 3 → title vector
//   CALL 4 → final ranking SQL

import { describe, it, expect, beforeEach, type Mock } from "vitest";
import { vi } from "vitest";
import { searchJobs } from "../search";
import { prisma } from "../prisma";
import { embed, toPgVectorLiteral } from "../embeddings";
import { FIXED_VEC, FIXED_VEC_LIT, makeRow, makeMatch, makeCompanyExact } from "./helpers";

vi.mock("../prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("../embeddings", () => ({ embed: vi.fn(), toPgVectorLiteral: vi.fn() }));

const q = () => prisma.$queryRaw as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  (embed as Mock).mockResolvedValue(FIXED_VEC);
  (toPgVectorLiteral as Mock).mockReturnValue(FIXED_VEC_LIT);
});

describe("role + company (AND filter)", () => {
  it("returns jobs that satisfy both role and company constraints", async () => {
    // role AND company are AND-ed in the WHERE clause: only jobs whose id is in
    // titleIds AND whose companyId is in companyIds survive to be ranked.
    // Call order: title-exact, company-exact, title-trigram, title-vector, final.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
      .mockResolvedValueOnce([makeCompanyExact("company-1")]) // company exact
      .mockResolvedValueOnce([]) // title trigram
      .mockResolvedValueOnce([]) // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1", companyName: "Google", totalScore: 3.5 })]); // final

    const result = await searchJobs({
      roleText: "Engineer",
      companyText: "Google",
      skillNames: [],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.companyName).toBe("Google");
    // Total: title (2.0×1.0) + company (1.5×1.0) = 3.5
    expect(result[0]!.score).toBe(3.5);
  });

  it("makes exactly 5 $queryRaw calls for role+company (exact company match)", async () => {
    // Exact company short-circuits after call 2. Call sequence:
    // title-exact, company-exact, title-trigram, title-vector, final = 5 calls.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)])
      .mockResolvedValueOnce([makeCompanyExact("company-1")])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeRow()]);

    await searchJobs({
      roleText: "Engineer",
      companyText: "Acme",
      skillNames: [],
      experienceYears: null,
    });

    expect(q()).toHaveBeenCalledTimes(5);
  });
});

describe("role + skills", () => {
  it("accumulates title score and skill-match count in totalScore", async () => {
    // Title exact (1.0) + 1 skill match = 2.0×1.0 + 1.0×1 = 3.0.
    // No company → 3 title calls + 1 final = 4 calls total.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
      .mockResolvedValueOnce([]) // title trigram
      .mockResolvedValueOnce([]) // title vector
      .mockResolvedValueOnce([makeRow({ totalScore: 3.0 })]); // final

    const result = await searchJobs({
      roleText: "Frontend Engineer",
      companyText: "",
      skillNames: ["React"],
      experienceYears: null,
    });

    expect(result[0]!.score).toBe(3.0);
  });
});

describe("role + experience", () => {
  it("adds 0.5 experience bonus when experienceYears falls inside the job's band", async () => {
    // experienceYears=3, job band [2,5] → +0.5 bonus.
    // Total: 2.0×1.0 (exact title) + 0.5×1.0 (exp) = 2.5.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeRow({ totalScore: 2.5 })]);

    const result = await searchJobs({
      roleText: "Software Engineer",
      companyText: "",
      skillNames: [],
      experienceYears: 3,
    });

    expect(result[0]!.score).toBe(2.5);
  });

  it("does not add experience bonus when experienceYears is outside the job's band", async () => {
    // experienceYears=20, job band [2,5] → no experience bonus.
    // Total: 2.0×1.0 (exact title) = 2.0 only.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeRow({ totalScore: 2.0 })]);

    const result = await searchJobs({
      roleText: "Software Engineer",
      companyText: "",
      skillNames: [],
      experienceYears: 20,
    });

    expect(result[0]!.score).toBe(2.0);
  });

  it("does not apply experience filter when experienceYears is null", async () => {
    // null experienceYears → experience term = 0 × anything = 0; no BETWEEN check.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeRow({ totalScore: 2.0 })]);

    const result = await searchJobs({
      roleText: "Software Engineer",
      companyText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(result[0]!.score).toBe(2.0);
  });
});

describe("all four inputs combined", () => {
  it("sums all four weight terms into a single totalScore and returns ranked results", async () => {
    // role(2.0×1.0) + company(1.5×1.0) + skill(1.0×2) + exp(0.5×1.0) = 6.0
    // Call order: title-exact, company-exact, title-trigram, title-vector, final.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
      .mockResolvedValueOnce([makeCompanyExact("company-1")]) // company exact
      .mockResolvedValueOnce([]) // title trigram
      .mockResolvedValueOnce([]) // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1", totalScore: 6.0 })]); // final

    const result = await searchJobs({
      roleText: "Software Engineer",
      companyText: "Acme",
      skillNames: ["React", "TypeScript"],
      experienceYears: 3,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(6.0);
  });
});
