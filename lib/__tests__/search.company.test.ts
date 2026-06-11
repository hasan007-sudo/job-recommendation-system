// Group 4 — Company-only search
// Tests the exact → trigram waterfall for matchCompanyIds.
// No vector tier exists for companies; a trigram score below 0.4 is rejected.
//
// $queryRaw call order for company-only (no roleText, no skills):
//   CALL 1 → company exact
//   CALL 2 → company trigram  (only if exact returned [])
//   LAST   → final ranking SQL

import { describe, it, expect, beforeEach, type Mock } from "vitest";
import { vi } from "vitest";
import { searchJobs } from "../search";
import { prisma } from "../prisma";
import { embed, toPgVectorLiteral } from "../embeddings";
import { FIXED_VEC, FIXED_VEC_LIT, makeRow, makeCompanyExact, makeCompanyTrigram } from "./helpers";

vi.mock("../prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("../embeddings", () => ({ embed: vi.fn(), toPgVectorLiteral: vi.fn() }));

const q = () => prisma.$queryRaw as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  (embed as Mock).mockResolvedValue(FIXED_VEC);
  (toPgVectorLiteral as Mock).mockReturnValue(FIXED_VEC_LIT);
});

describe("company-only search", () => {
  it("returns jobs when company name matches exactly (no trigram fallback needed)", async () => {
    // Exact match on company name — matchCompanyIds returns immediately after call 1.
    // All jobs at that company enter the candidate set via the company tier.
    q()
      .mockResolvedValueOnce([makeCompanyExact("company-1")]) // company exact
      .mockResolvedValueOnce([makeRow({ companyName: "Google" })]); // final

    const result = await searchJobs({
      roleText: "",
      companyText: "Google",
      skills: [],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.companyName).toBe("Google");
    // embed should NOT be called — no roleText provided
    expect(embed).not.toHaveBeenCalled();
  });

  it("returns jobs when company name matches via trigram (score ≥ 0.4 threshold)", async () => {
    // Exact fails; trigram similarity 0.5 clears the MIN_COMPANY_TRIGRAM_SIMILARITY = 0.4 floor.
    // matchCompanyIds returns the company id and the final SQL runs normally.
    q()
      .mockResolvedValueOnce([])                                      // company exact
      .mockResolvedValueOnce([makeCompanyTrigram("company-1", 0.5)])  // company trigram
      .mockResolvedValueOnce([makeRow({ companyName: "Google" })]); // final

    const result = await searchJobs({
      roleText: "",
      companyText: "Googl", // partial / typo
      skills: [],
      experienceYears: null,
    });

    expect(result).toHaveLength(1);
  });

  it("returns [] when trigram score is below the 0.4 floor (false positives rejected)", async () => {
    // Trigram similarity 0.3 < MIN_COMPANY_TRIGRAM_SIMILARITY → matchCompanyIds returns [].
    // companyIds = [], titleMatches = [], skills = [] → guard fires → no final SQL.
    q()
      .mockResolvedValueOnce([])                                      // company exact
      .mockResolvedValueOnce([makeCompanyTrigram("company-1", 0.3)]); // company trigram (rejected)

    const result = await searchJobs({
      roleText: "",
      companyText: "Ggl",
      skills: [],
      experienceYears: null,
    });

    expect(result).toEqual([]);
    // Only 2 calls: exact + trigram. No final SQL because guard fired.
    expect(q()).toHaveBeenCalledTimes(2);
  });

  it("returns [] when both company tiers return no results", async () => {
    // Neither exact nor trigram find the company → companyIds = [] → guard fires.
    q()
      .mockResolvedValueOnce([]) // company exact
      .mockResolvedValueOnce([]); // company trigram

    const result = await searchJobs({
      roleText: "",
      companyText: "Unknown Corp XYZ",
      skills: [],
      experienceYears: null,
    });

    expect(result).toEqual([]);
  });

  it("makes exactly 2 $queryRaw calls when company exact matches (exact + final, no trigram)", async () => {
    // Exact match short-circuits; trigram query is never made.
    q()
      .mockResolvedValueOnce([makeCompanyExact("company-1")])
      .mockResolvedValueOnce([makeRow()]);

    await searchJobs({
      roleText: "",
      companyText: "Acme",
      skills: [],
      experienceYears: null,
    });

    expect(q()).toHaveBeenCalledTimes(2);
  });
});
