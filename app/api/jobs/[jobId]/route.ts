import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { buildRounds } from "../../../../lib/rounds";
import { deriveSeniority } from "../../../../lib/search";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { company: true },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json({
    job: {
      jobId: job.id,
      jobTitle: job.jobTitle,
      companyName: job.company.name,
      seniority: deriveSeniority(job.experienceMinYears),
      experienceMinYears: job.experienceMinYears,
      experienceMaxYears: job.experienceMaxYears,
      location: job.location,
      workMode: job.workMode,
      educationRequirement: job.educationRequirement,
      requiredSkills: job.requiredSkills,
      roleSummary: job.roleSummary,
      sourceUrl: job.sourceUrl,
      fullJobDescription: job.fullJobDescription,
      rounds: buildRounds(job),
    },
  });
}
