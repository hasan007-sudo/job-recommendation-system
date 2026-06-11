// Group 6 — Combined inputs
// Tests role+company, role+skills, role+experience, and all-four together.
//
// With skills present, covered-skill resolution runs first (CALL 1), then the
// retrieval paths run in parallel (Promise.all) and their $queryRaw calls
// interleave in deterministic microtask-FIFO order:
//
// role+company (no skills):
//   CALL 1 → title exact        CALL 2 → company exact
//   CALL 3 → title trigram      CALL 4 → title vector ANN
//   LAST   → final scoring SQL
//
// role+skills (no company):
//   CALL 1 → covered-skill resolution
//   CALL 2 → title exact        CALL 3 → skill-path candidates
//   CALL 4 → title trigram      CALL 5 → title vector ANN
//   LAST   → final scoring SQL

import { describe, it, expect, beforeEach, type Mock } from "vitest";
import { vi } from "vitest";
import { searchJobs } from "../search";
import { prisma } from "../prisma";
import { embed, toPgVectorLiteral } from "../embeddings";
import {
  FIXED_VEC,
  FIXED_VEC_LIT,
  makeRow,
  makeMatch,
  makeCompanyExact,
  makeSkillId,
  makeSkillJob,
} from "./helpers";

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
    // role and company both contribute candidate ids to the UNION; tier < 2
    // maps to roleOrCompanyMatched.
    q()
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
      .mockResolvedValueOnce([makeCompanyExact("company-1")]) // company exact
      .mockResolvedValueOnce([]) // title trigram
      .mockResolvedValueOnce([]) // title vector
      .mockResolvedValueOnce([
        makeRow({ jobId: "job-1", companyName: "Google", tier: 0 }),
      ]); // final

    const result = await searchJobs({
      roleText: "Engineer",
      companyText: "Google",
      skills: [],
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
      skills: [],
      experienceYears: null,
    });

    expect(q()).toHaveBeenCalledTimes(5);
  });
});

describe("role + skills", () => {
  it("resolves covered skills, runs 3 title tiers + skill path + final, and maps coverage through", async () => {
    q()
      .mockResolvedValueOnce([makeSkillId("skill-react")]) // covered skills
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
      .mockResolvedValueOnce([makeSkillJob("job-1")]) // skill-path candidates
      .mockResolvedValueOnce([]) // title trigram
      .mockResolvedValueOnce([]) // title vector
      .mockResolvedValueOnce([
        makeRow({ covered: 1, required: 2, skillsPct: 50, score: 33 }),
      ]); // final

    const result = await searchJobs({
      roleText: "Frontend Engineer",
      companyText: "",
      skills: [{ name: "React" }],
      experienceYears: null,
    });

    expect(q()).toHaveBeenCalledTimes(6);
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
      skills: [],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.jobId).toBe("job-1");
  });
});

describe("all four inputs combined", () => {
  it("makes 7 calls and returns a single ranked result for role+company+skills+experience", async () => {
    // covered-skills, then title-exact, company-exact, skill-path interleave,
    // then title-trigram, title-vector, final.
    q()
      .mockResolvedValueOnce([makeSkillId("skill-react")]) // covered skills
      .mockResolvedValueOnce([makeMatch("job-1", 1.0)]) // title exact
      .mockResolvedValueOnce([makeCompanyExact("company-1")]) // company exact
      .mockResolvedValueOnce([makeSkillJob("job-1")]) // skill-path candidates
      .mockResolvedValueOnce([]) // title trigram
      .mockResolvedValueOnce([]) // title vector
      .mockResolvedValueOnce([makeRow({ jobId: "job-1" })]); // final

    const result = await searchJobs({
      roleText: "Software Engineer",
      companyText: "Acme",
      skills: [{ name: "React" }, { name: "TypeScript" }],
      experienceYears: 3,
    });

    expect(q()).toHaveBeenCalledTimes(7);
    expect(result).toHaveLength(1);
  });
});
