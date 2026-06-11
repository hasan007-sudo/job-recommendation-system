// Skill glosses: one-line LLM descriptions used as the embedding input for
// skills. Bare-token Titan embeddings are not separable (aws↔cloud computing
// 0.23 vs c++↔python 0.26); glossed embeddings are (signal 0.25–0.62, noise
// 0.0–0.15). See docs/ARCHITECTURE.md "Why glosses are mandatory".

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Skill-token normalization. Keeps '+' and '#' so C, C++, and C# stay distinct
// tokens (stripping them would collapse all three to "c").
export function normalizeSkillToken(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9+#]/g, "");
}

const SYSTEM_PROMPT = `You write one-line glosses for skill names found in job postings and resumes.
For each input skill, return a short description (8-15 words) of what the skill is,
expanding acronyms and naming the domain.
Reply ONLY with JSON: {"glosses": {"<skill name>": "<Name (expanded)>: <description>"}}.
Example: {"glosses": {"AWS": "AWS (Amazon Web Services): cloud computing platform, cloud infrastructure services"}}
Every input skill must appear as a key, spelled exactly as given.`;

// One batched LLM call: skill names → glosses. Callers are responsible for
// only sending names that don't already have a stored gloss.
export async function glossSkills(names: string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();

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
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ skills: names }) },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Gloss request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(content) as { glosses?: Record<string, string> };

  const out = new Map<string, string>();
  for (const name of names) {
    const gloss = parsed.glosses?.[name];
    // Fall back to the name itself rather than failing the batch — a missing
    // gloss degrades that one skill, not the whole import.
    out.set(name, typeof gloss === "string" && gloss.trim() ? gloss.trim() : name);
  }
  return out;
}
