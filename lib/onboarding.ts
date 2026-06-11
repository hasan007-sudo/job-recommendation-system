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
  experience: string[];
  scores: { cgpa: string; twelfth: string; tenth: string };
  roleHint: string;
  experienceYears: number;
  // Compact text used as the resume side of the embedding similarity match.
  // Built at parse time from skills + experience + roleHint.
  resumeText: string;
};

export const EMPTY_PROFILE: OnboardingProfile = {
  name: "",
  education: { degree: "", major: "", institution: "", years: "", standing: "" },
  skills: [],
  skillGlosses: {},
  projects: [],
  projectKeywords: [],
  experience: [],
  scores: { cgpa: "", twelfth: "", tenth: "" },
  roleHint: "",
  experienceYears: 0,
  resumeText: "",
};

// Build the input for the existing job search from an (edited) profile.
export function deriveSearchInput(profile: OnboardingProfile): SearchInput {
  // Project evidence text = description + keywords. Descriptions carry the
  // stronger signal of what was built; keywords sharpen the domain terms.
  // Pre-keyword profiles fall back to prose-only.
  const projectTexts =
    profile.projects.length > 0
      ? profile.projects.map((p, i) => {
          const kws = profile.projectKeywords?.[i] ?? [];
          return kws.length > 0 ? `${p}. Keywords: ${kws.join(", ")}` : p;
        })
      : (profile.projectKeywords ?? [])
          .map((kws) => kws.join(", "))
          .filter(Boolean);

  return {
    companyText: "",
    roleText: profile.roleHint,
    skills: profile.skills.map((name) => ({
      name,
      gloss: profile.skillGlosses?.[name],
    })),
    experienceYears: profile.experienceYears,
    projectTexts,
    sort: "default",
  };
}
