import {
  AccessToken,
  type AccessTokenOptions,
  AgentDispatchClient,
  RoomServiceClient,
  type VideoGrant,
} from "livekit-server-sdk";

const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const liveKitUrl = process.env.LIVEKIT_URL;

// Dispatch name the agent worker registers under (server.py: AGENT_NAME).
export const AGENT_NAME = process.env.LIVEKIT_AGENT_NAME || "intervoo-agent";
// Profile selected by the agent (config/agents.json) — the no-ChromaDB flow.
export const AGENT_ID = process.env.LIVEKIT_AGENT_ID || "diagnostic_v2";

export function getLiveKitCredentials() {
  if (!apiKey || !apiSecret || !liveKitUrl) {
    throw new Error("LiveKit credentials not configured");
  }
  return { apiKey, apiSecret, liveKitUrl };
}

export function createRoomServiceClient() {
  const { apiKey, apiSecret, liveKitUrl } = getLiveKitCredentials();
  return new RoomServiceClient(liveKitUrl, apiKey, apiSecret);
}

export function createAgentDispatchClient() {
  const { apiKey, apiSecret, liveKitUrl } = getLiveKitCredentials();
  return new AgentDispatchClient(liveKitUrl, apiKey, apiSecret);
}

export function buildInterviewRoomName(seed: string) {
  return `interview_${seed}_${Date.now()}`;
}

export async function createParticipantToken(params: {
  identity: string;
  name: string;
  roomName: string;
}) {
  const { apiKey, apiSecret } = getLiveKitCredentials();

  const tokenOptions: AccessTokenOptions = {
    identity: params.identity,
    name: params.name,
    ttl: "30m",
  };

  const accessToken = new AccessToken(apiKey, apiSecret, tokenOptions);

  const grant: VideoGrant = {
    room: params.roomName,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  };

  accessToken.addGrant(grant);

  return await accessToken.toJwt();
}
