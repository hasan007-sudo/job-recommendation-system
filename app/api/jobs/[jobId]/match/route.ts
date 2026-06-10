import { NextResponse } from "next/server";
import { z } from "zod";
import { scoreJobMatch } from "../../../../../lib/search";

// Computes the match % for one job against the candidate's profile (skills +
// projects). Kept separate from the job GET so job data stays cacheable and the
// match — which is profile-relative — is requested only when a profile exists.
const schema = z.object({
  skillNames: z.array(z.string()).default([]),
  projectTexts: z.array(z.string()).default([]),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const match = await scoreJobMatch(jobId, parsed.data);
    if (!match) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json({ match });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not compute match.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
