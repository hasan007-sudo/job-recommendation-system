import mammoth from "mammoth";
import { z } from "zod";
import type { OnboardingProfile } from "./onboarding";

const MAX_RESUME_CHARS = 8000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// DOCX embedded images are attached as image_url vision parts. Cap the count and
// drop tiny images (icons/logos/bullets) to control vision cost and noise.
const MAX_DOCX_IMAGES = 10;
const MIN_DOCX_IMAGE_BYTES = 3 * 1024;

// OpenAI-compatible content parts sent to OpenRouter as the user message.
type TextPart = { type: "text"; text: string };
type FilePart = { type: "file"; file: { filename: string; file_data: string } };
type ImagePart = { type: "image_url"; image_url: { url: string } };
type ContentPart = TextPart | FilePart | ImagePart;
type UserContent = string | ContentPart[];

type OcrPlugin = { id: "file-parser"; pdf: { engine: string } };

// ---------------------------------------------------------------------------
// 1. Content extraction per file type. PDFs are sent whole to OpenRouter's OCR
//    plugin (image-only content survives); DOCX yields text + embedded images;
//    TXT is plain text. Everything funnels through runExtraction below.
// ---------------------------------------------------------------------------

// TXT only — DOCX has its own extractor (it also needs images), PDF skips text.
export async function extractResumeText(file: File): Promise<string> {
  if (!file.name.toLowerCase().endsWith(".txt")) {
    throw new Error(
      "Unsupported file type. Upload a PDF, DOCX, or TXT resume.",
    );
  }
  const text = (await file.text())
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RESUME_CHARS);
  if (text.length < 100) {
    throw new Error(
      "Could not read enough text from this file. Try a different resume.",
    );
  }
  return text;
}

// DOCX → text (mammoth) + embedded images. Images are harvested via a custom
// convertImage handler during convertToHtml; the HTML output is discarded — we
// only collect the binaries so text baked into a pasted screenshot is not lost.
async function extractDocx(
  file: File,
): Promise<{ text: string; images: ImagePart[] }> {
  const buffer = Buffer.from(await file.arrayBuffer());

  const images: ImagePart[] = [];
  await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const base64 = await image.readAsBase64String();
        const bytes = Math.floor((base64.length * 3) / 4);
        if (bytes >= MIN_DOCX_IMAGE_BYTES && images.length < MAX_DOCX_IMAGES) {
          images.push({
            type: "image_url",
            image_url: { url: `data:${image.contentType};base64,${base64}` },
          });
        }
        return { src: "" };
      }),
    },
  );

  const { value } = await mammoth.extractRawText({ buffer });
  const text = value.replace(/\s+/g, " ").trim().slice(0, MAX_RESUME_CHARS);

  // A DOCX with neither readable text nor images is unusable.
  if (text.length < 100 && images.length === 0) {
    throw new Error(
      "Could not read enough text from this file. Try a different resume.",
    );
  }
  return { text, images };
}

async function fileToDataUri(file: File, mime: string): Promise<string> {
  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  return `data:${mime};base64,${base64}`;
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
- FALLBACK: If the resume contains NO standalone projects at all (no side, personal, academic, hackathon, or open-source projects anywhere), derive 2-4 "projects" entries from the most significant initiatives described in the work experience instead — each a distinct system, feature, or migration the candidate built or led (e.g. a real-time gateway, a platform migration, a data pipeline). Use the initiative as "name", a one-sentence summary of what was built and its impact as "description", and 3-8 keywords. Keep "work_experience" as the normal company/role entries only. Apply this fallback ONLY when "projects" would otherwise be empty.
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
      }),
    )
    .default([]),
  skills: z.array(z.string()).default([]),
  projects: z
    .array(
      z.object({
        name: z.string().nullish(),
        description: z.string().nullish(),
        keywords: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  work_experience: z
    .array(
      z.object({ company: z.string().nullish(), role: z.string().nullish() }),
    )
    .default([]),
  experience_years: z.number().nullish(),
  strongest_domain: z.string().nullish(),
});
type ParsedResume = z.infer<typeof ParsedResume>;

// Shared LLM call: takes the already-built user content (a plain string, or
// content parts for PDF/DOCX) and an optional plugin (PDF OCR), returns the
// mapped profile. All file types funnel through here.
async function runExtraction(
  userContent: UserContent,
  plugin?: OcrPlugin,
): Promise<OnboardingProfile> {
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
        { role: "user", content: userContent },
      ],
      ...(plugin ? { plugins: [plugin] } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const json = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("LLM did not return valid JSON.");
  }

  return mapToProfile(ParsedResume.parse(raw));
}

// Single entry point: dispatch on file type, build the right user content, and
// run the shared extraction.
export async function parseResume(file: File): Promise<OnboardingProfile> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf")) {
    // PDF whole-file → OCR plugin (mistral-ocr). Model-agnostic: the plugin
    // parses the document (including image-only content) before the model sees it.
    const dataUri = await fileToDataUri(file, "application/pdf");
    const content: ContentPart[] = [
      {
        type: "text",
        text: "Resume document attached. Return the JSON object only.",
      },
      { type: "file", file: { filename: file.name, file_data: dataUri } },
    ];
    return runExtraction(content, {
      id: "file-parser",
      pdf: { engine: "mistral-ocr" },
    });
  }

  if (name.endsWith(".docx")) {
    const { text, images } = await extractDocx(file);
    if (images.length === 0) {
      // No images → plain text path, no vision needed.
      return runExtraction(
        `Resume:\n\n${text}\n\nReturn the JSON object only.`,
      );
    }
    const content: ContentPart[] = [
      {
        type: "text",
        text: `Resume text plus attached images (read text inside the images too). Return the JSON object only.\n\n${text}`,
      },
      ...images,
    ];
    return runExtraction(content);
  }

  if (name.endsWith(".txt")) {
    const text = await extractResumeText(file);
    return runExtraction(`Resume:\n\n${text}\n\nReturn the JSON object only.`);
  }

  throw new Error("Unsupported file type. Upload a PDF, DOCX, or TXT resume.");
}

// ---------------------------------------------------------------------------
// 3. Mapping helpers
// ---------------------------------------------------------------------------

function mapToProfile(parsed: ParsedResume): OnboardingProfile {
  const edu = parsed.education[0];
  const projects = parsed.projects
    .filter((p) => p.name)
    .map((p) =>
      p.description ? `${p.name} · ${p.description}` : (p.name as string),
    );
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
    scores: {
      cgpa: edu?.cgpa != null ? String(edu.cgpa) : "",
      twelfth: "",
      tenth: "",
    },
    roleHint: parsed.strongest_domain ?? parsed.work_experience[0]?.role ?? "",
    experienceYears: Math.max(0, Math.round(parsed.experience_years ?? 0)),
    resumeText: buildResumeText(parsed),
  };
}

function buildResumeText(parsed: ParsedResume): string {
  const roleHint =
    parsed.strongest_domain ?? parsed.work_experience[0]?.role ?? "";
  const skills = dedupe(parsed.skills.map((s) => s.trim()).filter(Boolean));
  const projects = parsed.projects
    .filter((p) => p.name)
    .map((p) =>
      p.description ? `${p.name}: ${p.description}` : (p.name as string),
    );
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
