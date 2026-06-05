import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { z } from "zod";
import type { OnboardingProfile } from "./onboarding";

const MAX_RESUME_CHARS = 8000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ---------------------------------------------------------------------------
// 1. Text extraction (PDF via unpdf, DOCX via mammoth, plain text otherwise)
// ---------------------------------------------------------------------------

export async function extractResumeText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  let raw: string;

  if (name.endsWith(".pdf")) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    raw = text;
  } else if (name.endsWith(".docx")) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { value } = await mammoth.extractRawText({ buffer });
    raw = value;
  } else if (name.endsWith(".txt")) {
    raw = await file.text();
  } else {
    throw new Error("Unsupported file type. Upload a PDF, DOCX, or TXT resume.");
  }

  const text = raw.replace(/\s+/g, " ").trim().slice(0, MAX_RESUME_CHARS);
  if (text.length < 100) {
    throw new Error("Could not read enough text from this file. Try a different resume.");
  }
  return text;
}

// ---------------------------------------------------------------------------
// 2. LLM extraction (OpenRouter, OpenAI-compatible). Ports the structured-JSON
//    approach from Resume_upload_analyze, trimmed to the fields we use.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You extract structured data from a candidate's resume for a job-matching product.
Return ONLY a single JSON object, no prose, matching exactly this shape:
{
  "name": string | null,
  "education": [
    { "institution": string, "degree": string, "major": string | null,
      "graduation_year": number | null, "cgpa": string | null, "is_current": boolean }
  ],
  "skills": string[],            // every technical skill, tool, framework, and language listed
  "projects": [ { "name": string, "description": string | null, "keywords": string[] } ],  // side, personal, academic, or open-source projects only; keywords = 3-8 domain skills / tech concepts
  "work_experience": [ { "company": string, "role": string } ],       // paid employment at a real company only
  "experience_years": number,    // total full-time work experience in years (0 for students/new grads; internships count as ~0)
  "strongest_domain": string | null  // e.g. "Web Development", "Data Science", "QA Automation"
}
Rules:
- Use [] for missing lists and null for missing scalars; never invent data.
- "skills" must be a flat, de-duplicated list of concrete skill names.
- "work_experience" is ONLY actual job-related work: paid employment (full-time, part-time, contract) or internships at a real company or organization. Each entry must be a role the candidate was employed for. Internships count here.
- "projects" is ONLY side-projects, personal projects, academic/course projects, hackathon work, and open-source contributions. These are NOT employment.
- Never put a project in "work_experience" and never put a job in "projects". If something has no employing company (e.g. a personal app, a GitHub repo, a college project), it is a project, not work experience.
- "project keywords" must be domain skills or tech concepts only (e.g. "real-time systems", "WebSocket", "distributed caching"). Exclude soft skills, team size, awards, and process words.
- "cgpa" is ONLY a numeric grade. Accept formats like "8.44", "3.7", "9.2/10", "72%", or grade classes like "First Class". Reject and set to null anything that describes how the degree was taken or its honours level — for example "Dist." / "Distance" / "Distance Education", "Regular", "Part-time" / "Full-time", "Online" / "Correspondence", "Hons." / "Honours". If the resume shows e.g. "B.E. (Dist.)" with no numeric grade, set cgpa to null and leave the "(Dist.)" out of every field (it is not a score, not a major, not a degree suffix worth keeping).
- Return only the JSON object.`;

const ParsedResume = z.object({
  name: z.string().nullish(),
  education: z
    .array(
      z.object({
        institution: z.string().nullish(),
        degree: z.string().nullish(),
        major: z.string().nullish(),
        graduation_year: z.number().nullish(),
        cgpa: z.union([z.string(), z.number()]).nullish(),
        is_current: z.boolean().nullish(),
      })
    )
    .default([]),
  skills: z.array(z.string()).default([]),
  projects: z.array(z.object({ name: z.string().nullish(), description: z.string().nullish(), keywords: z.array(z.string()).default([]) })).default([]),
  work_experience: z.array(z.object({ company: z.string().nullish(), role: z.string().nullish() })).default([]),
  experience_years: z.number().nullish(),
  strongest_domain: z.string().nullish(),
});
type ParsedResume = z.infer<typeof ParsedResume>;

export async function analyzeResume(text: string): Promise<OnboardingProfile> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set.");
  }
  const model = process.env.LLM_MODEL || "openai/gpt-4o-mini";

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Resume:\n\n${text}\n\nReturn the JSON object only.` },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const json = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("LLM did not return valid JSON.");
  }

  return mapToProfile(ParsedResume.parse(raw));
}

// ---------------------------------------------------------------------------
// 3. Mapping helpers
// ---------------------------------------------------------------------------

function mapToProfile(parsed: ParsedResume): OnboardingProfile {
  const edu = parsed.education[0];
  const projects = parsed.projects
    .filter((p) => p.name)
    .map((p) => (p.description ? `${p.name} · ${p.description}` : (p.name as string)));
  const work = parsed.work_experience
    .filter((w) => w.role || w.company)
    .map((w) => [w.role, w.company].filter(Boolean).join(" · "));

  return {
    name: parsed.name ?? "",
    education: {
      degree: edu?.degree ?? "",
      major: edu?.major ?? "",
      institution: edu?.institution ?? "",
      years: edu?.graduation_year ? String(edu.graduation_year) : "",
      standing: edu?.is_current ? "current" : "",
    },
    skills: dedupe(parsed.skills.map((s) => s.trim()).filter(Boolean)),
    projects,
    projectKeywords: parsed.projects.map((p) => p.keywords ?? []),
    experience: work,
    scores: { cgpa: edu?.cgpa != null ? String(edu.cgpa) : "", twelfth: "", tenth: "" },
    roleHint: parsed.strongest_domain ?? parsed.work_experience[0]?.role ?? "",
    experienceYears: Math.max(0, Math.round(parsed.experience_years ?? 0)),
    resumeText: buildResumeText(parsed),
  };
}

function buildResumeText(parsed: ParsedResume): string {
  const roleHint = parsed.strongest_domain ?? parsed.work_experience[0]?.role ?? "";
  const skills = dedupe(parsed.skills.map((s) => s.trim()).filter(Boolean));
  const projects = parsed.projects
    .filter((p) => p.name)
    .map((p) => (p.description ? `${p.name}: ${p.description}` : (p.name as string)));
  const work = parsed.work_experience
    .filter((w) => w.role || w.company)
    .map((w) => [w.role, w.company].filter(Boolean).join(" at "));
  return [roleHint, skills.join(", "), work.join(". "), projects.join(". ")]
    .filter((s) => s && s.trim())
    .join("\n");
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
