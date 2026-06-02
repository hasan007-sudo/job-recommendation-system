// Group 2 — Empty-query guard
// searchJobs must return [] and make zero DB calls when there is nothing to
// constrain on (no role, no company, no skills). This prevents a full-table dump.
// Also covers the case where role text is given but produces no title matches
// and no other filter is active.

import { describe, it, expect, beforeEach, type Mock } from "vitest";
import { vi } from "vitest";
import { searchJobs } from "../search";
import { prisma } from "../prisma";
import { embed, toPgVectorLiteral } from "../embeddings";
import { FIXED_VEC, FIXED_VEC_LIT } from "./helpers";

vi.mock("../prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("../embeddings", () => ({ embed: vi.fn(), toPgVectorLiteral: vi.fn() }));

const mockQuery = () => prisma.$queryRaw as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  (embed as Mock).mockResolvedValue(FIXED_VEC);
  (toPgVectorLiteral as Mock).mockReturnValue(FIXED_VEC_LIT);
});

describe("empty-query guard", () => {
  it("returns [] immediately when all inputs are empty, making no DB calls", async () => {
    // No role, company, or skills → guard fires before any query runs.
    const result = await searchJobs({
      companyText: "",
      roleText: "",
      skillNames: [],
      experienceYears: null,
    });

    expect(result).toEqual([]);
    expect(mockQuery()).not.toHaveBeenCalled();
  });

  it("returns [] when roleText is given but all three title tiers return no matches and no other filter is active", async () => {
    // All three title-matching queries (exact, trigram, vector) return empty.
    // titleMatches = [], companyIds = [], skills = [] → guard fires → no final SQL.
    // $queryRaw call order for role-only: 1=title-exact, 2=title-trigram, 3=title-vector.
    mockQuery()
      .mockResolvedValueOnce([]) // title exact
      .mockResolvedValueOnce([]) // title trigram
      .mockResolvedValueOnce([]); // title vector

    const result = await searchJobs({
      companyText: "",
      roleText: "Nonexistent Role XYZ",
      skillNames: [],
      experienceYears: null,
    });

    expect(result).toEqual([]);
    // Final ranking SQL must NOT have been called — guard should have stopped execution.
    expect(mockQuery()).toHaveBeenCalledTimes(3);
  });

  it("returns [] when skillNames contains only blank strings (stripped to empty)", async () => {
    // After trim + filter(Boolean), skills become []. Combined with no role/company,
    // the guard fires and no queries run.
    const result = await searchJobs({
      companyText: "",
      roleText: "",
      skillNames: ["  ", "", "\t"],
      experienceYears: null,
    });

    expect(result).toEqual([]);
    expect(mockQuery()).not.toHaveBeenCalled();
  });
});
