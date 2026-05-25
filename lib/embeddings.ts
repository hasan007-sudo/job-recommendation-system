// Local sentence-transformer embeddings via @huggingface/transformers (Transformers.js v4).
// Model: Xenova/all-MiniLM-L6-v2 (384-dim, mean-pooled, L2-normalized).
// Cached in memory on first call; ~25MB model downloaded once and cached on disk.

import { LRUCache } from "lru-cache";

export const EMBEDDING_DIM = 384;

// We use `any` here because the Pipeline type is internal.
let embedderPromise: Promise<any> | null = null;

async function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = import("@huggingface/transformers").then(({ pipeline, env }) => {
      env.allowLocalModels = false;
      return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    });
  }
  return embedderPromise;
}

const cache = new LRUCache<string, number[]>({ max: 500 });

function normalizeKey(text: string): string {
  return text.trim().toLowerCase();
}

export async function embed(text: string): Promise<number[]> {
  const key = normalizeKey(text);
  if (!key) return new Array(EMBEDDING_DIM).fill(0);
  const hit = cache.get(key);
  if (hit) return hit;

  const embedder = await getEmbedder();
  const output = await embedder(key, { pooling: "mean", normalize: true });
  const vec = Array.from(output.data as Float32Array) as number[];
  cache.set(key, vec);
  return vec;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  // Sequential is fine — the pipeline is single-threaded. Cache hits skip the model.
  const result: number[][] = [];
  for (const text of texts) result.push(await embed(text));
  return result;
}

// Format a vector as a Postgres `vector` literal: '[0.1,0.2,...]'
export function toPgVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
