// Group 1 — deriveSeniority
// Pure function with no DB dependency; tests all boundary values for the
// entry / mid / senior classification based on experienceMinYears.

import { describe, it, expect, vi } from "vitest";
import { deriveSeniority } from "../search";

// deriveSeniority is pure, but importing ../search transitively loads ../prisma,
// which throws at import time unless ROUND_DB_URL is set. Mock the side-effectful
// modules (as the sibling test files do) so this pure-function suite runs anywhere.
vi.mock("../prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("../embeddings", () => ({ embed: vi.fn(), toPgVectorLiteral: vi.fn() }));

describe("deriveSeniority", () => {
  it("returns 'entry' when experienceYears is null (no data from resume)", () => {
    expect(deriveSeniority(null)).toBe("entry");
  });

  it("returns 'entry' when experienceYears is 0 (new grad / student)", () => {
    expect(deriveSeniority(0)).toBe("entry");
  });

  it("returns 'entry' at the upper boundary of 2 years", () => {
    expect(deriveSeniority(2)).toBe("entry");
  });

  it("returns 'mid' at the lower boundary of 3 years", () => {
    expect(deriveSeniority(3)).toBe("mid");
  });

  it("returns 'mid' at the upper boundary of 6 years", () => {
    expect(deriveSeniority(6)).toBe("mid");
  });

  it("returns 'senior' at the lower boundary of 7 years", () => {
    expect(deriveSeniority(7)).toBe("senior");
  });

  it("returns 'senior' for a deeply experienced candidate (12 years)", () => {
    expect(deriveSeniority(12)).toBe("senior");
  });
});
