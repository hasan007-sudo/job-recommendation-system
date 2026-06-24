import { z } from "zod";

// Resume-vs-JD fit analysis powering the job page's accordions. ONE LLM call
// returns, for this job: which required skills the resume covers, plus per-item
// "found"/"missing" analysis of the job's Requirements, Responsibilities, and
// Nice-To-Haves (extracted from the JD text where not already structured). It is
// anchored by our deterministic match % so the LLM's verdicts don't drift far
// from the engine's score. Mirrors lib/questions.ts (OpenRouter + zod).

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Bound the JD text we send so token use stays predictable on long postings.
const MAX_JD_CHARS = 6000;

export type JobFitInput = {
  jobTitle: string;
  roleSummary: string | null;
  requiredSkills: string[];
  responsibilities: string[];
  fullJobDescription: string | null;
  educationRequirement: string | null;
  candidateSkills?: string[];
  candidateExperience?: string[];
  candidateProjects?: string[];
  candidateInitiatives?: string[];
  experienceMinYears?: number;
  experienceMaxYears?: number;
  // Our deterministic match, passed as a calibration anchor.
  overallPct?: number | null;
  skillsPct?: number | null;
  projectsPct?: number | null;
};

export type FitStatus = "found" | "missing";
export type FitItem = { text: string; status: FitStatus };
export type FitSection = { items: FitItem[] };
export type SkillChip = { skill: string; matched: boolean };

export type JobFitAnalysis = {
  skills: SkillChip[];
  requirements: FitSection;
  responsibilities: FitSection;
  niceToHaves: FitSection;
};

const SYSTEM_PROMPT = `You assess how well a candidate's resume fits a specific job, producing an evidence breakdown.

You are given the job (title, summary, required skills, responsibilities, full description) and the candidate's resume. You also get OUR ENGINE'S MATCH SCORES — treat them as a calibration anchor: your verdicts should roughly agree with them (e.g. if skills match is 70%, most core skills should be "found"). Do not contradict them wildly.

Produce four things:
1. "matchedSkills": from the provided required-skills list, the EXACT skill strings the resume genuinely covers (a skill listed, or clearly used in a project/internship). Omit skills with no real evidence.
2. "requirements": the must-have requirements / qualifications. Use the provided required-skills as a base and ALSO extract any other hard requirements stated in the job description (knowledge areas, degrees, must-haves).
3. "responsibilities": the day-to-day responsibilities. Use the provided responsibilities list if non-empty; otherwise extract them from the job description.
4. "niceToHaves": the nice-to-have / bonus / preferred / "good to have" items extracted from the job description.

For every item in requirements, responsibilities, and niceToHaves, decide a "status":
- "found": the resume shows concrete evidence (a project, internship, role, skill, or coursework) that genuinely supports it.
- "missing": no real evidence.
Write each item's "text" as a clear, standalone requirement or responsibility:
- Use a concise phrase or sentence that is meaningful without extra explanation.
- Preserve concrete details such as technologies, degree fields, years of experience, and scope.
- Start responsibilities with an action verb where possible.
- Do not use vague fragments such as "Frontend", "Experience", or "Good communication".
- Do not include resume evidence, match reasoning, advice, or prefixes such as "Found:" and "Missing:".

Return ONLY this JSON object:
{
  "matchedSkills": string[],
  "requirements": [ { "text": string, "status": "found"|"missing" } ],
  "responsibilities": [ { "text": string, "status": "found"|"missing" } ],
  "niceToHaves": [ { "text": string, "status": "found"|"missing" } ]
}
Be specific and honest; never invent experience. Return only the JSON object, no prose.`;

const Item = z.object({
  text: z.string(),
  status: z.enum(["found", "missing"]),
});
const Raw = z.object({
  matchedSkills: z.array(z.string()).default([]),
  requirements: z.array(Item).default([]),
  responsibilities: z.array(Item).default([]),
  niceToHaves: z.array(Item).default([]),
});

function normSkill(s: string): string {
  return s.trim().toLowerCase();
}

function buildUserPrompt(input: JobFitInput): string {
  const lines: string[] = [];
  lines.push(`Job: ${input.jobTitle}`);
  if (input.roleSummary) lines.push(`Role summary: ${input.roleSummary}`);
  if (input.educationRequirement) lines.push(`Education requirement: ${input.educationRequirement}`);

  if (input.requiredSkills.length) {
    lines.push(`\nRequired skills:`);
    input.requiredSkills.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  if (input.responsibilities.length) {
    lines.push(`\nResponsibilities:`);
    input.responsibilities.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }
  if (input.fullJobDescription) {
    lines.push(`\nFull job description:\n${input.fullJobDescription.slice(0, MAX_JD_CHARS)}`);
  }

  const anchor: string[] = [];
  if (typeof input.overallPct === "number") anchor.push(`overall ${input.overallPct}%`);
  if (typeof input.skillsPct === "number") anchor.push(`skills ${input.skillsPct}%`);
  if (typeof input.projectsPct === "number") anchor.push(`projects ${input.projectsPct}%`);
  if (anchor.length) lines.push(`\nOur engine's match scores (calibration anchor): ${anchor.join(", ")}.`);

  lines.push(`\nCandidate resume:`);
  if (input.candidateSkills?.length) lines.push(`- Skills: ${input.candidateSkills.join(", ")}`);
  if (input.candidateExperience?.length)
    lines.push(`- Experience: ${input.candidateExperience.join("; ")}`);
  if (input.candidateInitiatives?.length)
    lines.push(`- Internship work: ${input.candidateInitiatives.join("; ")}`);
  if (input.candidateProjects?.length)
    lines.push(`- Projects: ${input.candidateProjects.join("; ")}`);
  if (
    typeof input.experienceMinYears === "number" &&
    typeof input.experienceMaxYears === "number"
  )
    lines.push(`- Years of experience: ${input.experienceMinYears}–${input.experienceMaxYears}`);

  return lines.join("\n");
}

function toSection(items: FitItem[]): FitSection {
  const cleaned = items
    .map((it) => ({ ...it, text: it.text.trim() }))
    .filter((it) => it.text);
  return { items: cleaned };
}

export async function analyzeJobFit(input: JobFitInput): Promise<JobFitAnalysis> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set.");
  const model = process.env.LLM_MODEL || "openai/gpt-4o-mini";

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
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

  const parsed = Raw.parse(raw);

  // Skills chips: the JD's required skills are the source of truth for the chip
  // list; the LLM only decides which are matched (green tick).
  const matched = new Set(parsed.matchedSkills.map(normSkill));
  const skills: SkillChip[] = input.requiredSkills.map((skill) => ({
    skill,
    matched: matched.has(normSkill(skill)),
  }));

  return {
    skills,
    requirements: toSection(parsed.requirements),
    responsibilities: toSection(parsed.responsibilities),
    niceToHaves: toSection(parsed.niceToHaves),
  };
}
