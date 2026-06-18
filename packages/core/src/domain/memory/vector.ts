/** Cosine similarity of two equal-length vectors. Returns 0 if either is a zero vector. Pure. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    na = 0,
    nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface Scored {
  id: string
  score: number
}

/** The k candidates most similar to `query`, score-desc. Brute-force (fine for a small set). */
export function topK(
  query: Float32Array,
  candidates: { id: string; embedding: Float32Array }[],
  k: number,
): Scored[] {
  return candidates
    .map((c) => ({ id: c.id, score: cosineSimilarity(query, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

/** Float32Array ↔ SQLite BLOB bytes. Write as a Buffer (accepted by every driver for binding); read
 *  back as a Uint8Array (what node:sqlite / bun:sqlite return for a BLOB — Buffer is a subclass). */
export const floatsToBuffer = (v: Float32Array): Buffer =>
  Buffer.from(v.buffer, v.byteOffset, v.byteLength)
export const bufferToFloats = (b: Uint8Array): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
