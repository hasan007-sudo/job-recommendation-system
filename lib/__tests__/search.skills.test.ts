// Group 5 — Skills-only search
// Skills resolve against the Skill catalog first (exact token; semantic only
// when a gloss is present), then the bounded skill path retrieves candidates,
// then the final SQL scores them. These mocked tests cover the JS-side
// behaviour; the SQL-side coverage/evidence math lives in the pgvector
// integration suite, not here.
//
// $queryRaw call order for skills-only (no roleText, no companyText, no gloss):
//   CALL 1 → covered-skill resolution (Skill catalog)
//   CALL 2 → skill-path candidates (JobSkill, bounded by coverage)
//   CALL 3 → final scoring SQL
// embed() is NOT called when no skill has a gloss and there is no role/project.

import { describe, it, expect, beforeEach, type Mock } from "vitest";
import { vi } from "vitest";
import { searchJobs } from "../search";
import { prisma } from "../prisma";
import { embed, toPgVectorLiteral } from "../embeddings";
import { FIXED_VEC, FIXED_VEC_LIT, makeRow, makeSkillId, makeSkillJob } from "./helpers";

vi.mock("../prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("../embeddings", () => ({ embed: vi.fn(), toPgVectorLiteral: vi.fn() }));

const q = () => prisma.$queryRaw as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  (embed as Mock).mockResolvedValue(FIXED_VEC);
  (toPgVectorLiteral as Mock).mockReturnValue(FIXED_VEC_LIT);
});

describe("skills-only search", () => {
  it("resolves the catalog, retrieves skill candidates, and scores — no embed without glosses", async () => {
    q()
      .mockResolvedValueOnce([makeSkillId("skill-react")]) // covered skills
      .mockResolvedValueOnce([makeSkillJob("job-1")]) // skill-path candidates
      .mockResolvedValueOnce([
        makeRow({ covered: 1, required: 1, skillsPct: 100, score: 65, tier: 2 }),
      ]); // final

    const result = await searchJobs({
      roleText: "",
      companyText: "",
      skills: [{ name: "React" }],
      experienceMinYears: null,
      experienceMaxYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(65);
    expect(result[0]!.matchedSkills).toBe(1);
    expect(result[0]!.totalSkills).toBe(1);
    expect(result[0]!.roleOrCompanyMatched).toBe(false);
    // embed must NOT be called — no gloss, no roleText, no projects
    expect(embed).not.toHaveBeenCalled();
    expect(q()).toHaveBeenCalledTimes(3);
  });

  it("embeds the gloss (not the name) when a skill carries one", async () => {
    q()
      .mockResolvedValueOnce([makeSkillId("skill-aws")])
      .mockResolvedValueOnce([makeSkillJob("job-1")])
      .mockResolvedValueOnce([makeRow()]);

    await searchJobs({
      roleText: "",
      companyText: "",
      skills: [{ name: "AWS", gloss: "AWS (Amazon Web Services): cloud computing platform" }],
      experienceMinYears: null,
      experienceMaxYears: null,
    });

    expect(embed).toHaveBeenCalledWith(
      "AWS (Amazon Web Services): cloud computing platform",
    );
  });

  it("returns [] and makes no DB calls when all skill entries are blank strings", async () => {
    // After trim + filter, skills becomes []. Combined with no role/company/
    // projects, the guard fires before any query is made.
    const result = await searchJobs({
      roleText: "",
      companyText: "",
      skills: [{ name: "  " }, { name: "" }, { name: "\t" }],
      experienceMinYears: null,
      experienceMaxYears: null,
    });

    expect(result).toEqual([]);
    expect(q()).not.toHaveBeenCalled();
  });

  it("preserves the SQL result order across multiple jobs", async () => {
    // The SQL returns rows already ranked (job-2 above job-1). searchJobs maps
    // them through without reordering, so the array order is preserved.
    q()
      .mockResolvedValueOnce([makeSkillId("skill-react")])
      .mockResolvedValueOnce([makeSkillJob("job-2"), makeSkillJob("job-1")])
      .mockResolvedValueOnce([
        makeRow({ jobId: "job-2", skillsPct: 100, score: 65 }),
        makeRow({ jobId: "job-1", skillsPct: 50, score: 33 }),
      ]);

    const result = await searchJobs({
      roleText: "",
      companyText: "",
      skills: [{ name: "React" }, { name: "TypeScript" }],
      experienceMinYears: null,
      experienceMaxYears: null,
    });

    expect(result[0]!.jobId).toBe("job-2");
    expect(result[1]!.jobId).toBe("job-1");
  });
});
