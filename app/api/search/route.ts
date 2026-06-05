import { NextResponse } from "next/server";
import { z } from "zod";
import { searchJobs } from "../../../lib/search";

const schema = z.object({
  companyText: z.string().default(""),
  roleText: z.string().default(""),
  skillNames: z.array(z.string()).default([]),
  experienceYears: z.number().int().min(0).max(60).nullable().default(null),
  projectTexts: z.array(z.string()).default([]),
  sort: z.enum(["default", "score"]).default("default"),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid search input" }, { status: 400 });
  }

  const cards = await searchJobs(parsed.data);
  return NextResponse.json({ cards });
}
