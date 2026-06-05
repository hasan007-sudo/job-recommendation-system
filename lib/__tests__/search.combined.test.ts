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

describe("role + company", () => {
  it("returns jobs that matched on role or company (role/company tier)", async () => {
    // role and company both contribute candidate ids to the UNION; the matched
    // job is flagged roleOrCompanyMatched in SQL.
    // Call order: title-exact, company-exact, title-trigram, title-vector, final.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
      .mockResolvedValueOnce([makeCompanyExact("company-1")]) // company exact
      .mockResolvedValueOnce([]) // title trigram
      .mockResolvedValueOnce([]) // title vector
      .mockResolvedValueOnce([
        makeRow({ jobId: "job-1", companyName: "Google", roleOrCompanyMatched: true }),
      ]); // final

    const result = await searchJobs({
      roleText: "Engineer",
      companyText: "Google",
      skillNames: [],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.companyName).toBe("Google");
    expect(result[0]!.roleOrCompanyMatched).toBe(true);
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
  it("runs 3 title tiers + final (no company) and maps skill coverage through", async () => {
    // No company → 3 title calls + 1 final = 4 calls total. The skill coverage
    // (matched/required, skillsPct) is computed in SQL and mapped through.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
      .mockResolvedValueOnce([]) // title trigram
      .mockResolvedValueOnce([]) // title vector
      .mockResolvedValueOnce([
        makeRow({ matched: 1, required: 2, skillsPct: 50, score: 50 }),
      ]); // final

    const result = await searchJobs({
      roleText: "Frontend Engineer",
      companyText: "",
      skillNames: ["React"],
      experienceYears: null,
    });

    expect(q()).toHaveBeenCalledTimes(4);
    expect(result[0]!.matchedSkills).toBe(1);
    expect(result[0]!.totalSkills).toBe(2);
    expect(result[0]!.skillsPct).toBe(50);
  });
});

describe("role + experience", () => {
  it("does not apply an experience filter when experienceYears is null", async () => {
    // experienceYears=null → the BETWEEN predicate is skipped in SQL. JS-side this
    // is just a passthrough path; verify it still runs the role-only call sequence.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeRow({ jobId: "job-1" })]);

    const result = await searchJobs({
      roleText: "Software Engineer",
      companyText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.jobId).toBe("job-1");
  });
});

describe("all four inputs combined", () => {
  it("makes 5 calls and returns a single ranked result for role+company+skills+experience", async () => {
    // skills and experience add no extra prep queries, so the call count matches
    // role+company: title-exact, company-exact, title-trigram, title-vector, final.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
      .mockResolvedValueOnce([makeCompanyExact("company-1")]) // company exact
      .mockResolvedValueOnce([]) // title trigram
      .mockResolvedValueOnce([]) // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1" })]); // final

    const result = await searchJobs({
      roleText: "Software Engineer",
      companyText: "Acme",
      skillNames: ["React", "TypeScript"],
      experienceYears: 3,
    });

    expect(q()).toHaveBeenCalledTimes(5);
    expect(result).toHaveLength(1);
  });
});
