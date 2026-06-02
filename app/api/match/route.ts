import { NextResponse } from "next/server";
import { z } from "zod";
import { computeMatchScores } from "../../../lib/match";

const schema = z.object({
  resumeText: z.string().default(""),
  jobIds: z.array(z.string()).default([]),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid match input" }, { status: 400 });
  }
  const scores = await computeMatchScores(parsed.data.resumeText, parsed.data.jobIds);
  return NextResponse.json({ scores });
}
