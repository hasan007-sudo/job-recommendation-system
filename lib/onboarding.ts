import type { SearchInput } from "./search";

// Client-safe onboarding types/helpers (no server-only deps). The heavy
// extraction + LLM code lives in ./resume and is used only by the API route.

// Profile shown on the onboarding edit screen. Mirrors the wireframe sections.
// `roleHint` / `experienceYears` are derived at parse time and carried through
// to drive the existing job search; they are not edited in the UI.
export type OnboardingProfile = {
  name: string;
  education: { degree: string; major: string; institution: string; years: string; standing: string };
  skills: string[];
  // Per-skill one-line gloss (name → gloss), emitted by the parser in the same
  // LLM call. Glosses are the embedding input for semantic skill matching;
  // skills without one (pre-gloss profiles) fall back to keyword-only matching.
  skillGlosses?: Record<string, string>;
  // Raw project entries ("name · description"), kept separate from the merged
  // `experience` list so the project-match criterion can score against them.
  projects: string[];
  // LLM-extracted domain skills/tech concepts per project, used for semantic matching.
  projectKeywords: string[][];
  // LLM-extracted verb-led capability statements per project ("Built X",
  // "Designed Y"), shaped like job responsibilities. These are the preferred
  // embedding units for the project↔JobCapability similarity match — terse
  // phrases align far better than the full project paragraph.
  projectCapabilities: string[][];
  experience: string[];
  // Per-internship initiative descriptions (what was actually built/delivered).
  // Pooled with project texts for capability matching so internship work counts.
  workInitiatives?: string[][];
  scores: { cgpa: string; twelfth: string; tenth: string };
  roleHint: string;
  experienceYears: number;
};

export const EMPTY_PROFILE: OnboardingProfile = {
  name: "",
  education: { degree: "", major: "", institution: "", years: "", standing: "" },
  skills: [],
  skillGlosses: {},
  projects: [],
  projectKeywords: [],
  projectCapabilities: [],
  experience: [],
  workInitiatives: [],
  scores: { cgpa: "", twelfth: "", tenth: "" },
  roleHint: "",
  experienceYears: 0,
};

// Project evidence units for the embedding match. Preferred: the LLM-extracted
// per-project capability statements ("Built X", "Designed Y") — terse, verb-led
// phrases that align with JobCapability rows. Per-project fallback to the older
// "description. Keywords: …" blob when a project has no capabilities; whole-list
// fallback to keywords-only for projectless profiles. Shared by deriveSearchInput
// and the legacy search page so both sides build identical text.
export function buildProjectTexts(profile: OnboardingProfile): string[] {
  if ((profile.projects ?? []).length > 0) {
    return profile.projects.flatMap((p, i) => {
      const caps = profile.projectCapabilities?.[i] ?? [];
      if (caps.length > 0) return caps;
      const kws = profile.projectKeywords?.[i] ?? [];
      return [kws.length > 0 ? `${p}. Keywords: ${kws.join(", ")}` : p];
    });
  }
  return (profile.projectKeywords ?? [])
    .map((kws) => kws.join(", "))
    .filter(Boolean);
}

// Build the input for the existing job search from an (edited) profile.
export function deriveSearchInput(profile: OnboardingProfile): SearchInput {
  const projectTexts = buildProjectTexts(profile);

  // Internship initiatives are pooled into the same vector set as projects.
  // The scoring logic already takes MAX cosine per capability across all vectors,
  // so adding more vectors only helps — the best evidence wins regardless of source.
  const initiativeTexts = (profile.workInitiatives ?? []).flat().filter(Boolean);

  return {
    companyText: "",
    roleText: profile.roleHint,
    skills: profile.skills.map((name) => ({
      name,
      gloss: profile.skillGlosses?.[name],
    })),
    experienceYears: profile.experienceYears,
    projectTexts: [...projectTexts, ...initiativeTexts],
    sort: "default",
  };
}
