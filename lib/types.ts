import type { RoundType, Seniority } from "@prisma/client";

export type CompanyOption = {
  id: string;
  name: string;
};

export type RoleOption = {
  id: string;
  roleSlug: string;
  roleName: string;
  seniority: Seniority;
};

export type SkillOption = {
  id: string;
  name: string;
  category: string;
};

// Returned by POST /api/search — one card per matching plan.
export type PlanCard = {
  planId: string;
  companyName: string | null;
  roleName: string;
  roleSlug: string;
  seniority: Seniority;
  roundCount: number;
  score: number;
  components: {
    company: number;
    role: number;
    skill: number;
    seniority: number;
  };
};

// Returned by GET /api/plan/[id] — full detail for the expanded card.
export type PlanDetailRound = {
  id: string;
  position: number;
  roundType: RoundType;
  title: string;
  description: string | null;
  durationMinutes: number | null;
};

export type PlanDetail = {
  planId: string;
  companyName: string | null;
  roleName: string;
  seniority: Seniority;
  roundCount: number;
  rounds: PlanDetailRound[];
};
