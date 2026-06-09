import { z } from "zod";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type QuestionInput = {
  roundTitle: string;
  competencies: string[];
  jobTitle: string;
  requiredSkills: string | null;
  roleSummary: string | null;
  candidateSkills?: string[];
  candidateExperience?: string[];
  candidateProjects?: string[];
  experienceYears?: number;
};

const SYSTEM_PROMPT = `You generate tailored interview questions for a specific round of a job interview.
Return ONLY a single JSON object matching exactly this shape:
{
  "questions": string[]
}
Rules:
- Generate exactly 10 questions that collectively cover all the round's competencies and job context.
- If candidate background is provided, personalise questions to their skills, projects, and experience level.
- Questions should sound like real interviewer questions (not generic advice).
- Return only the JSON object, no prose.`;

const Response = z.object({
  questions: z.array(z.string()).min(10).max(10),
});

export async function generateRoundQuestions(input: QuestionInput): Promise<string[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set.");
  const model = process.env.LLM_MODEL || "openai/gpt-4o-mini";

  const lines: string[] = [];
  lines.push(`Generate interview questions for the ${input.roundTitle} round.`);
  lines.push(`\nJob: ${input.jobTitle}`);
  if (input.requiredSkills) lines.push(`Required skills: ${input.requiredSkills}`);
  if (input.roleSummary) lines.push(`Role summary: ${input.roleSummary}`);
  if (input.competencies.length > 0)
    lines.push(`\nRound competencies: ${input.competencies.join(", ")}`);
  if (
    input.candidateSkills?.length ||
    input.candidateExperience?.length ||
    input.candidateProjects?.length
  ) {
    lines.push(`\nCandidate background:`);
    if (input.candidateSkills?.length)
      lines.push(`- Skills: ${input.candidateSkills.join(", ")}`);
    if (input.candidateExperience?.length)
      lines.push(`- Experience: ${input.candidateExperience.join("; ")}`);
    if (input.candidateProjects?.length)
      lines.push(`- Projects: ${input.candidateProjects.join("; ")}`);
    if (typeof input.experienceYears === "number")
      lines.push(`- Years of experience: ${input.experienceYears}`);
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: lines.join("\n") },
      ],
    }),
  });

  if (!res.ok) throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const json = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("LLM did not return valid JSON.");
  }

  return Response.parse(raw).questions;
}
