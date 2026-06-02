import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "../../../../lib/prisma";
import { parseRounds } from "../../../../lib/rounds";
import { deriveSeniority } from "../../../../lib/search";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT = `You analyze a job description (JD) and produce the core competencies an interviewer would assess across the interview rounds.
Return ONLY a single JSON object, no prose, matching exactly this shape:
{
  "groups": [
    {
      "name": string,   // one of: "Technical Competencies", "Problem-Solving & Delivery Competencies", "Behavioral / Soft Competencies", or another short category if clearly warranted
      "items": [
        { "title": string, "description": string }   // title is the competency (e.g. "Backend & Database Development"); description is 1–2 sentences of what it covers
      ]
    }
  ]
}
Rules:
- 2–4 groups. Each group should have 2–6 items.
- Be specific to this JD; do not output generic boilerplate.
- Do not invent technologies that are not in the JD.
- Return only the JSON object.`;

const CompetencySchema = z.object({
  groups: z.array(
    z.object({
      name: z.string(),
      items: z.array(z.object({ title: z.string(), description: z.string() })).default([]),
    })
  ).default([]),
});
export type Competencies = z.infer<typeof CompetencySchema>;

async function generateCompetencies(jd: string): Promise<Competencies> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set.");
  const model = process.env.LLM_MODEL || "openai/gpt-4o-mini";

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1800,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Job description:\n\n${jd}\n\nReturn the JSON object only.` },
      ],
    }),
  });

  if (!res.ok) throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const json = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return CompetencySchema.parse(JSON.parse(json));
}

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { company: true },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  let competencies: Competencies | null = null;
  if (job.competencies) {
    try {
      competencies = CompetencySchema.parse(JSON.parse(job.competencies));
    } catch {
      competencies = null;
    }
  }

  if (!competencies) {
    const jd = [job.roleSummary, job.keyResponsibilities, job.requiredSkills]
      .filter(Boolean)
      .join("\n\n");
    if (jd.trim().length > 0) {
      try {
        competencies = await generateCompetencies(jd);
        await prisma.job.update({
          where: { id: jobId },
          data: { competencies: JSON.stringify(competencies) },
        });
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : "Failed to generate competencies" },
          { status: 500 }
        );
      }
    } else {
      competencies = { groups: [] };
    }
  }

  return NextResponse.json({
    job: {
      jobId: job.id,
      jobTitle: job.jobTitle,
      companyName: job.company.name,
      seniority: deriveSeniority(job.experienceMinYears),
      experienceMinYears: job.experienceMinYears,
      experienceMaxYears: job.experienceMaxYears,
      rounds: parseRounds(job.focusRoundPattern),
      roleSummary: job.roleSummary,
    },
    competencies,
  });
}
