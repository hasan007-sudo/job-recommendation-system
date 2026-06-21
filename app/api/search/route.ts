import { NextResponse } from "next/server";
import { z } from "zod";
import { searchJobs } from "../../../lib/search";

const schema = z.object({
  companyText: z.string().default(""),
  roleText: z.string().default(""),
  // Glossed skills (from parsed profiles). Skills without a gloss — and the
  // legacy `skillNames` shape — match by exact normalized token only.
  skills: z
    .array(z.object({ name: z.string(), gloss: z.string().nullish() }))
    .default([]),
  skillNames: z.array(z.string()).default([]),
  experienceMinYears: z.number().int().min(0).max(60).nullable().default(null),
  experienceMaxYears: z.number().int().min(0).max(60).nullable().default(null),
  projectTexts: z.array(z.string()).default([]),
  sort: z.enum(["default", "score"]).default("default"),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid search input" }, { status: 400 });
  }

  const { skillNames, ...input } = parsed.data;
  const skills =
    input.skills.length > 0
      ? input.skills
      : skillNames.map((name) => ({ name }));

  const cards = await searchJobs({ ...input, skills });
  return NextResponse.json({ cards });
}
