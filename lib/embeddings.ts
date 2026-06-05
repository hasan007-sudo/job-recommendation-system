// Text embeddings via Amazon Bedrock — Titan Text Embeddings V2
// (amazon.titan-embed-text-v2:0), 512-dim, normalized (cosine-ready).
// Stateless: Bedrock only generates the vector; storage stays in Postgres
// (Job.embedding, vector(512)). Cached in memory per process.

import { LRUCache } from "lru-cache";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

export const EMBEDDING_DIM = 512;

const MODEL_ID = "amazon.titan-embed-text-v2:0";

let clientInstance: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!clientInstance) {
    const region = process.env.AWS_REGION;
    if (!region) throw new Error("AWS_REGION is required for Bedrock embeddings");
    // Credentials resolve from the standard AWS chain (env vars / role).
    clientInstance = new BedrockRuntimeClient({ region });
  }
  return clientInstance;
}

const cache = new LRUCache<string, number[]>({ max: 500 });

function normalizeKey(text: string): string {
  return text.trim().toLowerCase();
}

// One Titan invocation: text → 512-dim vector. `normalize: true` returns a
// unit-length vector, so it is cosine-ready as-is.
async function invokeTitan(text: string): Promise<number[]> {
  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      inputText: text,
      dimensions: EMBEDDING_DIM,
      normalize: true,
    }),
  });
  const response = await getClient().send(command);
  const payload = JSON.parse(new TextDecoder().decode(response.body));
  return payload.embedding as number[];
}

export async function embed(text: string): Promise<number[]> {
  const key = normalizeKey(text);
  if (!key) return new Array(EMBEDDING_DIM).fill(0);
  const hit = cache.get(key);
  if (hit) return hit;

  const vec = await invokeTitan(key);
  cache.set(key, vec);
  return vec;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  // Titan has no batch endpoint — one InvokeModel per text. Cache hits skip the call.
  const result: number[][] = [];
  for (const text of texts) result.push(await embed(text));
  return result;
}

// Format a vector as a Postgres `vector` literal: '[0.1,0.2,...]'
export function toPgVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
