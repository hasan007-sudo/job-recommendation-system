import { z } from "zod";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type QuestionInput = {
  roundSlug: string;
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

// Single question shape shared with the LiveKit agent. The agent reads
// `id`, `text`, and `question_type` from each object (room metadata `questions`)
// and publishes the full object on `diagnostic_question_started`.
export type GeneratedQuestion = {
  id: string;
  text: string;
  question_type: ("Language" | "Thinking" | "Confidence")[];
};

const SYSTEM_PROMPT = `You generate tailored interview questions for a specific round of a job interview.
Return ONLY a single JSON object matching exactly this shape:
{
  "questions": [
    {
      "text": string,
      "question_type": ("Language" | "Thinking" | "Confidence")[]
    }
  ]
}
Rules:
- Generate exactly 10 questions that collectively cover all the round's competencies and job context.
- If candidate background is provided, personalise questions to their skills, projects, and experience level.
- Questions should sound like real interviewer questions (not generic advice).
- Each question must be a single, focused sentence — no compound questions and no follow-up prompts appended (never "X? Can you give an example?").
- "question_type" is the set of dimensions the question primarily assesses: "Language" (spoken English clarity), "Thinking" (reasoning/problem-solving), "Confidence" (self-assurance/communication). Include at least one.
- Use simple, clear language at a B1 English level — short sentences, everyday words, no idioms or complex phrases. The candidate should be able to understand the question immediately without re-reading it.
- If the candidate has 0–1 years of experience (fresher or recent graduate), ask questions about attitude, motivation, values, and general scenarios — not questions that assume work experience with clients, teams, or business targets. A fresher should be able to answer from college, personal projects, or daily life. Good fresher question examples: "Why do you want this job?", "How do you handle it when someone says no to you?", "Have you ever tried to convince someone of an idea? What happened?", "Are you comfortable working towards a target every month?".
- Return only the JSON object, no prose.`;

const Response = z.object({
  questions: z
    .array(
      z.object({
        text: z.string(),
        question_type: z.array(z.enum(["Language", "Thinking", "Confidence"])),
      }),
    )
    .min(10)
    .max(10),
});

export async function generateRoundQuestions(
  input: QuestionInput,
): Promise<GeneratedQuestion[]> {
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

  return Response.parse(raw)
    .questions.filter((q) => q.text.trim() && q.question_type.length)
    .map((q, i) => ({
      id: `${input.roundSlug}_q${i + 1}`,
      text: q.text.trim(),
      question_type: q.question_type,
    }));
}
