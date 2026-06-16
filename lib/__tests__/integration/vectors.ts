// Deterministic 512-dim vectors for the integration scoring tests.
// We never call Bedrock here — embed() is mocked and job embeddings are written
// directly — so cosine similarities are exact and the SQL scoring is verifiable.

export const DIM = 512;

export function zero(): number[] {
  return new Array(DIM).fill(0);
}

// Unit vector along a single axis.
export function axis(i: number): number[] {
  const v = zero();
  v[i] = 1;
  return v;
}

// Unit vector whose cosine similarity to axis(0) is exactly `cos` (0..1):
//   cos·e0 + sqrt(1-cos²)·e1  →  dot with e0 = cos, and it is unit-length.
export function cosOf(cos: number): number[] {
  const v = zero();
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}

// Postgres pgvector literal (matches the real toPgVectorLiteral output shape).
export function literal(v: number[]): string {
  return `[${v.join(",")}]`;
}
