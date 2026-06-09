import { NextResponse } from "next/server";
import { z } from "zod";
import {
  AGENT_ID,
  AGENT_NAME,
  buildInterviewRoomName,
  createAgentDispatchClient,
  createParticipantToken,
  createRoomServiceClient,
  getLiveKitCredentials,
} from "../../../../lib/livekit";

// App round slug → the agent's expected `current_round` value (v4 prompt §10).
const ROUND_TO_CURRENT: Record<string, string> = {
  screening: "screening",
  behavioural: "behavioral",
  technical: "technical-thinking",
  culture_fit: "career-readiness",
};

const bodySchema = z.object({
  jobId: z.string().min(1),
  roundSlug: z.string().min(1),
  roundTitle: z.string().min(1),
  questions: z.array(z.string().min(1)).min(1),
  candidateName: z.string().trim().min(1).optional(),
  jobTitle: z.string().optional(),
});

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  let liveKitUrl: string;
  try {
    ({ liveKitUrl } = getLiveKitCredentials());
  } catch {
    return NextResponse.json(
      { error: "LiveKit is not configured on the server" },
      { status: 500 },
    );
  }

  const { jobId, roundSlug, roundTitle, questions, candidateName, jobTitle } = parsed;
  const currentRound = ROUND_TO_CURRENT[roundSlug] ?? roundSlug;

  const roomName = buildInterviewRoomName(jobId);
  const participantIdentity = `cand_${crypto.randomUUID()}`;
  const participantName = candidateName?.trim() || "Candidate";

  // Same metadata contract as the diagnostics repo, but the v4 (no-ChromaDB)
  // profile reads the round's questions from top-level `questions` instead of
  // pulling them from ChromaDB via `question_filters`.
  const roomMetadata = {
    agent_id: AGENT_ID,
    user_id: participantIdentity,
    session_id: roomName,
    interaction_mode: "auto",
    questions,
    config: { voice: "ishita" },
    prompt_context: {
      agent_name: "Sara",
      user_name: participantName,
      current_round: currentRound,
      selected_job_title: jobTitle ?? "",
      round_title: roundTitle,
    },
  };
  const metadataJson = JSON.stringify(roomMetadata);

  try {
    // Room metadata is what the agent reads (server.py: ctx.job.room.metadata).
    const roomClient = createRoomServiceClient();
    await roomClient.createRoom({
      name: roomName,
      metadata: metadataJson,
      emptyTimeout: 60 * 15,
      maxParticipants: 3,
    });

    // Explicit dispatch of the registered agent into this room.
    const dispatchClient = createAgentDispatchClient();
    await dispatchClient.createDispatch(roomName, AGENT_NAME, {
      metadata: metadataJson,
    });

    const participantToken = await createParticipantToken({
      identity: participantIdentity,
      name: participantName,
      roomName,
    });

    return NextResponse.json({
      server_url: liveKitUrl,
      room_name: roomName,
      participant_token: participantToken,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
