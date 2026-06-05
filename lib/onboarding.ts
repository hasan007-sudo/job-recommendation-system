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
  // Use LLM-extracted per-project keyword strings when available; fall back to
  // raw project prose for sessions parsed before this field existed.
  const projectTexts =
    profile.projectKeywords && profile.projectKeywords.length > 0
      ? profile.projectKeywords.map((kws) => kws.join(", ")).filter(Boolean)
      : profile.projects.length > 0
        ? [profile.projects.join(". ")]
        : [];

  return {
    companyText: "",
    roleText: profile.roleHint,
    skillNames: profile.skills,
    experienceYears: profile.experienceYears,
    projectTexts,
    sort: "default",
  };
}
