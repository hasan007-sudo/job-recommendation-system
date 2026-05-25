import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import type { PlanDetail } from "../../../../lib/types";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const plan = await prisma.interviewPlan.findUnique({
    where: { id },
    include: {
      company: true,
      roleProfile: true,
      rounds: { orderBy: { position: "asc" } },
    },
  });

  if (!plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  const detail: PlanDetail = {
    planId: plan.id,
    companyName: plan.company?.name ?? null,
    roleName: plan.roleProfile.roleName,
    seniority: plan.roleProfile.seniority,
    roundCount: plan.cachedRoundCount,
    rounds: plan.rounds.map((r) => ({
      id: r.id,
      position: r.position,
      roundType: r.roundType,
      title: r.title,
      description: r.description,
      durationMinutes: r.durationMinutes,
    })),
  };

  return NextResponse.json(detail);
}
