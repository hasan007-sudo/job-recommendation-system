// Integration coverage for the SQL scoring/ranking pipeline in lib/search.ts.
// Runs against a real pgvector Postgres (see global-setup.ts) because the
// coverage counting, the gloss-semantic resolution, the project-evidence window,
// the 65/35 blend, the experience hard filter, the tiers, and the tie-break all
// live inside SQL and cannot be exercised with a mocked $queryRaw.
//
// Only the LLM/Bedrock edges are faked: embed() returns a registered vector so
// cosine similarity is exact, and glossSkills() is stubbed (we pre-seed the
// catalog, so gloss-on-miss never runs). normalizeSkillToken stays real so the
// seeded Skill.token matches what resolveCoveredSkillIds computes.
//
// Score arithmetic uses /5 skill ratios and evidence values chosen so 0.65·x and
// 0.35·x are integers — avoiding Postgres half-rounding ambiguity.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { axis, cosOf, DIM } from "./vectors";
import { reset, seedCompany, seedJob, seedSkill } from "./seed";

// text→vector registry shared with the mock factory (hoisted above imports).
const H = vi.hoisted(() => ({ reg: new Map<string, number[]>() }));

vi.mock("../../embeddings", () => ({
  EMBEDDING_DIM: 512,
  embed: vi.fn(async (text: string) => H.reg.get(text.trim().toLowerCase()) ?? new Array(512).fill(0)),
  toPgVectorLiteral: (v: number[]) => `[${v.join(",")}]`,
}));

// Keep normalizeSkillToken real; only stub the OpenRouter gloss call.
vi.mock("../../glosses", async (orig) => {
  const actual = await orig<typeof import("../../glosses")>();
  return { ...actual, glossSkills: vi.fn(async () => new Map<string, string>()) };
});

import { searchJobs } from "../../search";
import { prisma } from "../../prisma";

// Register the vector embed() should return for a given text (case-insensitive).
function register(text: string, vec: number[]) {
  H.reg.set(text.toLowerCase(), vec);
}

beforeAll(async () => {
  expect(DIM).toBe(512);
  // Safety net: prove we're on the throwaway container (testcontainers default
  // database is "test"), not production, BEFORE any write (TRUNCATE/seed) runs.
  const rows = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
    "SELECT current_database()",
  );
  const db = rows[0]?.current_database;
  if (db !== "test") {
    throw new Error(
      `integration tests refusing to run against database "${db}" (expected throwaway "test")`,
    );
  }
});

beforeEach(async () => {
  H.reg.clear();
  await reset(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ── requiredSkillScore (covered/required) + the 0.65 skill weight ────────────
describe("skill coverage score", () => {
  it("full coverage → skillsPct 100, score = round(0.65*100) = 65", async () => {
    const react = await seedSkill(prisma, { token: "react" });
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, { title: "Engineer", skillIds: [react] });

    const [card] = await searchJobs({
      roleText: "",
      companyText: "",
      skills: [{ name: "React" }],
      experienceYears: null,
    });

    expect(card.skillsPct).toBe(100);
    expect(card.projectsPct).toBeNull();
    expect(card.score).toBe(65);
    expect(card.matchedSkills).toBe(1);
    expect(card.totalSkills).toBe(1);
    expect(card.roleOrCompanyMatched).toBe(false); // skill tier (2)
  });

  it("partial coverage 1 of 5 → skillsPct 20, score = round(0.65*20) = 13", async () => {
    const react = await seedSkill(prisma, { token: "react" });
    const filler = [];
    for (let i = 0; i < 4; i++) filler.push(await seedSkill(prisma, { token: `filler${i}` }));
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, { title: "Engineer", skillIds: [react, ...filler] });

    const [card] = await searchJobs({
      roleText: "",
      companyText: "",
      skills: [{ name: "React" }],
      experienceYears: null,
    });

    expect(card.totalSkills).toBe(5);
    expect(card.matchedSkills).toBe(1);
    expect(card.skillsPct).toBe(20);
    expect(card.score).toBe(13);
  });

  it("a job with no required skills scores skillsPct 0 when skills are queried", async () => {
    await seedSkill(prisma, { token: "react" });
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, { title: "Engineer" }); // no JobSkill rows

    // Brought in by company match (skill path can't surface a required=0 job).
    const [card] = await searchJobs({
      roleText: "",
      companyText: "Acme",
      skills: [{ name: "React" }],
      experienceYears: null,
    });

    expect(card.totalSkills).toBe(0);
    expect(card.skillsPct).toBe(0);
    expect(card.score).toBe(0);
  });
});

// ── Gloss-semantic coverage (SEMANTIC_SKILL_MIN = 0.3) ───────────────────────
describe("semantic skill coverage", () => {
  it("covers a catalog skill when the candidate gloss embedding is ≥ 0.3 cosine", async () => {
    // Catalog 'kubernetes' gloss vector = axis(0). Candidate 'k8s' glosses to a
    // vector with cosine 0.5 to it → covered, even though tokens differ.
    const kube = await seedSkill(prisma, { token: "kubernetes", gloss: "k8s gloss", embedding: axis(0) });
    register("container orchestration", cosOf(0.5));
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, { title: "Engineer", skillIds: [kube] });

    const [card] = await searchJobs({
      roleText: "",
      companyText: "",
      skills: [{ name: "k8s", gloss: "container orchestration" }],
      experienceYears: null,
    });

    expect(card.matchedSkills).toBe(1);
    expect(card.skillsPct).toBe(100);
  });

  it("does not cover when the gloss cosine is below 0.3 (no candidate → empty)", async () => {
    await seedSkill(prisma, { token: "kubernetes", gloss: "k8s gloss", embedding: axis(0) });
    register("unrelated thing", cosOf(0.2)); // below floor
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, {
      title: "Engineer",
      skillIds: [(await prisma.skill.findFirstOrThrow()).id],
    });

    const result = await searchJobs({
      roleText: "",
      companyText: "",
      skills: [{ name: "k8s", gloss: "unrelated thing" }],
      experienceYears: null,
    });

    expect(result).toEqual([]); // nothing covered → no skill path → guard returns []
  });
});

// ── projectEvidenceScore window (MIN 0.10, MAX 0.35) + the 0.35 weight ───────
describe("project evidence score", () => {
  async function projectsPctFor(cos: number): Promise<number | null> {
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, {
      title: "Engineer",
      capabilities: [{ embedding: axis(0) }],
    });
    register("proj", cosOf(cos));
    const [card] = await searchJobs({
      roleText: "",
      companyText: "Acme",
      skills: [],
      experienceYears: null,
      projectTexts: ["proj"],
    });
    return card.projectsPct;
  }

  it.each([
    { cos: 0.35, pct: 100 }, // window ceiling
    { cos: 0.3, pct: 80 }, // (0.3-0.1)/0.25
    { cos: 0.1, pct: 0 }, // window floor
    { cos: 0.05, pct: 0 }, // below floor → clamped
  ])("cosine $cos → projects% $pct", async ({ cos, pct }) => {
    expect(await projectsPctFor(cos)).toBe(pct);
  });

  it("projects-only score applies the 0.35 weight (evidence 100 → score 35)", async () => {
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, { title: "Engineer", capabilities: [{ embedding: axis(0) }] });
    register("proj", cosOf(0.35));

    const [card] = await searchJobs({
      roleText: "",
      companyText: "Acme",
      skills: [],
      experienceYears: null,
      projectTexts: ["proj"],
    });

    expect(card.skillsPct).toBeNull();
    expect(card.projectsPct).toBe(100);
    expect(card.score).toBe(35); // round(0.35 * 100)
  });

  it("averages evidence across the job's capabilities", async () => {
    // cap A (axis 0) is hit by the project (cos 0.3 → 80); cap B (axis 2) is
    // orthogonal to the project vector → 0. AVG(80, 0) = 40.
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, {
      title: "Engineer",
      capabilities: [{ embedding: axis(0) }, { embedding: axis(2) }],
    });
    register("proj", cosOf(0.3));

    const [card] = await searchJobs({
      roleText: "",
      companyText: "Acme",
      skills: [],
      experienceYears: null,
      projectTexts: ["proj"],
    });

    expect(card.projectsPct).toBe(40);
  });

  it("takes the MAX cosine across project vectors for a capability", async () => {
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, { title: "Engineer", capabilities: [{ embedding: axis(0) }] });
    register("low", cosOf(0.15));
    register("high", cosOf(0.3)); // → 80

    const [card] = await searchJobs({
      roleText: "",
      companyText: "Acme",
      skills: [],
      experienceYears: null,
      projectTexts: ["low", "high"],
    });

    expect(card.projectsPct).toBe(80);
  });
});

// ── Blend of both sub-scores ─────────────────────────────────────────────────
describe("blended score", () => {
  it("skills 100 + projects 100 → score 100", async () => {
    const react = await seedSkill(prisma, { token: "react" });
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, {
      title: "Engineer",
      skillIds: [react],
      capabilities: [{ embedding: axis(0) }],
    });
    register("proj", cosOf(0.35));

    const [card] = await searchJobs({
      roleText: "",
      companyText: "",
      skills: [{ name: "React" }],
      experienceYears: null,
      projectTexts: ["proj"],
    });

    expect(card.skillsPct).toBe(100);
    expect(card.projectsPct).toBe(100);
    expect(card.score).toBe(100); // round(0.65*100 + 0.35*100)
  });

  it("skills 60 + projects 80 → score = round(0.65*60 + 0.35*80) = 67", async () => {
    const covered = [];
    for (const t of ["react", "vue", "angular"]) covered.push(await seedSkill(prisma, { token: t }));
    const filler = [];
    for (const t of ["fa", "fb"]) filler.push(await seedSkill(prisma, { token: t }));
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, {
      title: "Engineer",
      skillIds: [...covered, ...filler], // 3 covered of 5 → 60
      capabilities: [{ embedding: axis(0) }],
    });
    register("proj", cosOf(0.3)); // → 80

    const [card] = await searchJobs({
      roleText: "",
      companyText: "",
      skills: [{ name: "React" }, { name: "Vue" }, { name: "Angular" }],
      experienceYears: null,
      projectTexts: ["proj"],
    });

    expect(card.skillsPct).toBe(60);
    expect(card.projectsPct).toBe(80);
    expect(card.score).toBe(67);
  });
});

// ── Experience as a hard filter ──────────────────────────────────────────────
describe("experience hard filter", () => {
  beforeEach(async () => {
    const react = await seedSkill(prisma, { token: "react" });
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, { title: "In Band", skillIds: [react], experienceMinYears: 2, experienceMaxYears: 5 });
    await seedJob(prisma, company, { title: "Out Of Band", skillIds: [react], experienceMinYears: 8, experienceMaxYears: 10 });
    await seedJob(prisma, company, { title: "Open Band", skillIds: [react], experienceMinYears: null, experienceMaxYears: null });
  });

  it("excludes jobs whose band does not contain experienceYears", async () => {
    const titles = (
      await searchJobs({ roleText: "", companyText: "", skills: [{ name: "React" }], experienceYears: 3 })
    ).map((c) => c.jobTitle);

    expect(titles).toContain("In Band");
    expect(titles).toContain("Open Band"); // null/null coalesced to [0,99]
    expect(titles).not.toContain("Out Of Band");
  });

  it("applies no experience filter when experienceYears is null", async () => {
    const cards = await searchJobs({ roleText: "", companyText: "", skills: [{ name: "React" }], experienceYears: null });
    expect(cards).toHaveLength(3);
  });
});

// ── Tiers: default floats company→role→skill; score is pure top-N ────────────
describe("tier ordering and sort modes", () => {
  beforeEach(async () => {
    const ids = [];
    for (const t of ["react", "vue", "angular", "node", "ts"]) ids.push(await seedSkill(prisma, { token: t }));
    const [react, vue, angular, node, ts] = ids;
    const filler = [];
    for (const t of ["fa", "fb", "fc", "fd"]) filler.push(await seedSkill(prisma, { token: t }));

    // Distinct titles (no shared trigrams) so role matching only hits "Bravo".
    // Tier 0 (company Acme): covers 1 of 5 → skillsPct 20 → score 13.
    const acme = await seedCompany(prisma, "Acme");
    await seedJob(prisma, acme, { title: "Alpha", skillIds: [react, ...filler] });

    // Tier 1 (role title match): covers 3 of 5 → skillsPct 60 → score 39.
    const beta = await seedCompany(prisma, "Beta");
    await seedJob(prisma, beta, { title: "Bravo", skillIds: [react, vue, angular, filler[0], filler[1]] });

    // Tier 2 (skill only): covers 5 of 5 → skillsPct 100 → score 65.
    const gamma = await seedCompany(prisma, "Gamma");
    await seedJob(prisma, gamma, { title: "Charlie", skillIds: [react, vue, angular, node, ts] });
  });

  const allSkills = [
    { name: "React" }, { name: "Vue" }, { name: "Angular" }, { name: "Node" }, { name: "TS" },
  ];

  it("default sort orders company → role → skill regardless of score", async () => {
    const titles = (
      await searchJobs({ roleText: "Bravo", companyText: "Acme", skills: allSkills, experienceYears: null, sort: "default" })
    ).map((c) => c.jobTitle);

    expect(titles).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("score sort orders by matchScore, ignoring tier", async () => {
    const cards = await searchJobs({ roleText: "Bravo", companyText: "Acme", skills: allSkills, experienceYears: null, sort: "score" });

    expect(cards.map((c) => c.jobTitle)).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect(cards.map((c) => c.score)).toEqual([65, 39, 13]);
  });
});

// ── Tie-break: equal score within a tier ordered by createdAt ASC ────────────
describe("tie-break", () => {
  it("orders equal-score rows by createdAt ascending (oldest first)", async () => {
    const react = await seedSkill(prisma, { token: "react" });
    const company = await seedCompany(prisma, "Acme");
    await seedJob(prisma, company, { title: "Newer", skillIds: [react], createdAt: new Date("2024-02-01") });
    await seedJob(prisma, company, { title: "Older", skillIds: [react], createdAt: new Date("2024-01-01") });

    const cards = await searchJobs({ roleText: "", companyText: "", skills: [{ name: "React" }], experienceYears: null });

    expect(cards.map((c) => c.jobTitle)).toEqual(["Older", "Newer"]);
    expect(cards.every((c) => c.score === 65)).toBe(true);
  });
});
