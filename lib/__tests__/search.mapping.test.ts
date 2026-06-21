// Group 8 — Result shape and mapping
// Verifies that focusRoundPattern is parsed into rounds correctly (using the real
// parseRounds — not mocked), that roundCount matches rounds.length, that seniority
// is derived from experienceMinYears, and that unknown round segments fall back to "other".

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

// Helper: role-only search returning a single custom row.
async function searchWithRow(rowOverrides: Parameters<typeof makeRow>[0]) {
  q()
    .mockResolvedValueOnce([makeMatch("job-1", 1.0)])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([makeRow({ jobId: "job-1", ...rowOverrides })]);

  return searchJobs({
    roleText: "Engineer",
    companyText: "",
    skills: [],
    experienceMinYears: null,
      experienceMaxYears: null,
  });
}

describe("focusRoundPattern → rounds", () => {
  it("parses a two-segment pattern into an ordered rounds array with correct slugs", async () => {
    // Real parseRounds is not mocked — exercises the actual parsing logic.
    const result = await searchWithRow({
      focusRoundPattern: "Opening/Screening+Technical/Role Skills",
    });

    expect(result[0]!.rounds).toHaveLength(2);
    expect(result[0]!.rounds[0]!.slug).toBe("opening");
    expect(result[0]!.rounds[0]!.position).toBe(1);
    expect(result[0]!.rounds[1]!.slug).toBe("technical");
    expect(result[0]!.rounds[1]!.position).toBe(2);
  });

  it("sets roundCount equal to rounds.length", async () => {
    // Three segments → roundCount must be 3.
    const result = await searchWithRow({
      focusRoundPattern:
        "Opening/Screening+Technical/Role Skills+Final/Culture Fit",
    });

    expect(result[0]!.roundCount).toBe(3);
    expect(result[0]!.roundCount).toBe(result[0]!.rounds.length);
  });

  it("falls back to slug 'other' for unknown round segments", async () => {
    // A segment not in the closed 7-segment vocabulary maps to { slug: 'other' }.
    const result = await searchWithRow({
      focusRoundPattern: "Mystery Round",
    });

    expect(result[0]!.rounds[0]!.slug).toBe("other");
  });

  it("returns roundCount = 0 when focusRoundPattern is empty string", async () => {
    // Empty pattern → parseRounds returns [] → roundCount = 0.
    const result = await searchWithRow({ focusRoundPattern: "" });

    expect(result[0]!.roundCount).toBe(0);
    expect(result[0]!.rounds).toEqual([]);
  });
});

describe("seniority derivation from experienceMinYears", () => {
  it("maps experienceMinYears = null to 'entry'", async () => {
    const result = await searchWithRow({ experienceMinYears: null });
    expect(result[0]!.seniority).toBe("entry");
  });

  it("maps experienceMinYears = 1 to 'entry'", async () => {
    const result = await searchWithRow({ experienceMinYears: 1 });
    expect(result[0]!.seniority).toBe("entry");
  });

  it("maps experienceMinYears = 4 to 'mid'", async () => {
    const result = await searchWithRow({ experienceMinYears: 4 });
    expect(result[0]!.seniority).toBe("mid");
  });

  it("maps experienceMinYears = 8 to 'senior'", async () => {
    const result = await searchWithRow({ experienceMinYears: 8 });
    expect(result[0]!.seniority).toBe("senior");
  });
});

describe("JobCard field passthrough", () => {
  it("maps jobId, jobTitle, companyName directly from the SQL row", async () => {
    const result = await searchWithRow({
      jobId: "abc-123",
      jobTitle: "Staff Engineer",
      companyName: "Stripe",
    });

    expect(result[0]!.jobId).toBe("abc-123");
    expect(result[0]!.jobTitle).toBe("Staff Engineer");
    expect(result[0]!.companyName).toBe("Stripe");
  });

  it("preserves experienceMinYears and experienceMaxYears on the card", async () => {
    const result = await searchWithRow({
      experienceMinYears: 3,
      experienceMaxYears: 7,
    });

    expect(result[0]!.experienceMinYears).toBe(3);
    expect(result[0]!.experienceMaxYears).toBe(7);
  });
});
