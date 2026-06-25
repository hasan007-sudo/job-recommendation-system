"use client";

import { useQuery } from "@tanstack/react-query";
import { getJson, postJson } from "../lib/api";
import type { ParsedRound } from "../lib/rounds";

export type Skill = { name: string };

export type JobCard = {
  jobId: string;
  jobTitle: string;
  companyName: string;
  seniority: string;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  roundCount: number;
  rounds: ParsedRound[];
  score: number | null;
  skillsPct: number | null;
  projectsPct: number | null;
  roleOrCompanyMatched: boolean;
  matchedSkills: number | null;
  totalSkills: number;
};

export type SortMode = "default" | "score";

export type SearchInput = {
  companyText: string;
  roleText: string;
  // Skills with their parse-time glosses. Manually typed skills have no gloss,
  // so they are exact-token matches only.
  skills: { name: string; gloss?: string }[];
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  projectTexts: string[];
  sort: SortMode;
};

export function useJobOptions() {
  return useQuery({
    queryKey: ["options"],
    queryFn: () => getJson<{ skills: Skill[] }>("/api/options"),
    staleTime: 5 * 60_000,
  });
}

export function useJobSearch(searchInput: SearchInput | null) {
  return useQuery({
    queryKey: ["search", searchInput],
    queryFn: () => postJson<{ cards: JobCard[] }>("/api/search", searchInput!),
    enabled: searchInput != null,
    // Dedupe overlapping fires and serve cached results on back-navigation.
    staleTime: 60_000,
  });
}
