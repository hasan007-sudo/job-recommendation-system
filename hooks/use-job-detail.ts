"use client";

import { useQuery } from "@tanstack/react-query";
import { getJson, postJson } from "../lib/api";
import type { JobFitAnalysis } from "../lib/job-fit";
import { deriveSearchInput, type OnboardingProfile } from "../lib/onboarding";
import type { Round } from "../lib/rounds";

export type JobDetail = {
  job: {
    jobId: string;
    jobTitle: string;
    companyName: string;
    seniority: string;
    experienceMinYears: number | null;
    experienceMaxYears: number | null;
    location: string | null;
    workMode: string | null;
    educationRequirement: string | null;
    requiredSkills: string | null;
    roleSummary: string | null;
    salaryInrMinPerYear: number | null;
    salaryInrMaxPerYear: number | null;
    sourceUrl: string | null;
    fullJobDescription: string | null;
    rounds: Round[];
  };
};

export type JobMatchResponse = {
  match?: {
    score: number | null;
    skillsPct: number | null;
    projectsPct: number | null;
  };
};

export function useJobDetail(jobId: string) {
  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => getJson<JobDetail>(`/api/jobs/${jobId}`),
  });
}

export function useJobMatch(
  jobId: string,
  profile: OnboardingProfile | null,
) {
  return useQuery({
    queryKey: ["job-match", jobId, profile?.skills, profile?.projectKeywords],
    enabled: !!profile,
    queryFn: () => {
      const { skills, projectTexts } = deriveSearchInput(profile!);
      return postJson<JobMatchResponse>(`/api/jobs/${jobId}/match`, {
        skills,
        projectTexts,
      });
    },
  });
}

export function useJobAnalysis({
  jobId,
  match,
  profile,
}: {
  jobId: string;
  match: JobMatchResponse | undefined;
  profile: OnboardingProfile | null;
}) {
  const matchPercent = match?.match?.score ?? undefined;
  const skillsPct = match?.match?.skillsPct ?? undefined;
  const projectsPct = match?.match?.projectsPct ?? undefined;

  return useQuery({
    queryKey: [
      "job-analysis",
      jobId,
      profile?.skills,
      profile?.projects,
      profile?.experience,
      matchPercent,
      skillsPct,
      projectsPct,
    ],
    enabled: !!profile && match !== undefined,
    queryFn: () =>
      postJson<{ analysis?: JobFitAnalysis }>(`/api/jobs/${jobId}/analysis`, {
        candidateSkills: profile!.skills,
        candidateExperience: profile!.experience,
        candidateProjects: profile!.projects,
        candidateInitiatives: (profile!.workInitiatives ?? [])
          .flat()
          .filter(Boolean),
        experienceMinYears: profile!.experienceMinYears,
        experienceMaxYears: profile!.experienceMaxYears,
        overallPct: matchPercent ?? null,
        skillsPct: skillsPct ?? null,
        projectsPct: projectsPct ?? null,
      }),
  });
}
