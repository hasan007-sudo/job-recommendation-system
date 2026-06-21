import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "../../../../../lib/prisma";
import { analyzeJobFit } from "../../../../../lib/job-fit";

// Single fit-analysis endpoint for the job page: skills + requirements +
// responsibilities + nice-to-haves in one LLM call. The job text is read
// server-side; the candidate context and our deterministic match scores (the
// calibration anchor) come from the body.
const schema = z.object({
  candidateSkills: z.array(z.string()).optional(),
  candidateExperience: z.array(z.string()).optional(),
  candidateProjects: z.array(z.string()).optional(),
  candidateInitiatives: z.array(z.string()).optional(),
  experienceMinYears: z.number().optional(),
  experienceMaxYears: z.number().optional(),
  overallPct: z.number().nullish(),
  skillsPct: z.number().nullish(),
  projectsPct: z.number().nullish(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      jobTitle: true,
      roleSummary: true,
      requiredSkills: true,
      keyResponsibilities: true,
      fullJobDescription: true,
      educationRequirement: true,
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const requiredSkills = (job.requiredSkills ?? "")
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const responsibilities = (job.keyResponsibilities ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const analysis = await analyzeJobFit({
      jobTitle: job.jobTitle,
      roleSummary: job.roleSummary,
      requiredSkills,
      responsibilities,
      fullJobDescription: job.fullJobDescription,
      educationRequirement: job.educationRequirement,
      ...parsed.data,
    });
    return NextResponse.json({ analysis });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not analyze this job.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
