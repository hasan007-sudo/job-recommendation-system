import { NextResponse } from "next/server";
import { z } from "zod";
import { generateRoundQuestions } from "../../../../../lib/questions";

const schema = z.object({
  roundSlug: z.string(),
  roundTitle: z.string(),
  competencies: z.array(z.string()).default([]),
  jobTitle: z.string(),
  requiredSkills: z.string().nullable().default(null),
  roleSummary: z.string().nullable().default(null),
  candidateSkills: z.array(z.string()).optional(),
  candidateExperience: z.array(z.string()).optional(),
  candidateProjects: z.array(z.string()).optional(),
  experienceMinYears: z.number().optional(),
  experienceMaxYears: z.number().optional(),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const questions = await generateRoundQuestions(parsed.data);
    return NextResponse.json({ questions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not generate questions.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
