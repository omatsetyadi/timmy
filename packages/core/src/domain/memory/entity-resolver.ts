import { cosineSimilarity } from './vector'

/** Canonicalize a surface form for matching: lowercase, `_`/`-` → space, drop punctuation,
 *  collapse whitespace. So "Omat_Setyadi", "omat setyadi", "Omat-Setyadi" all match. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const USER_TERMS = new Set(['i', 'me', 'my', 'myself', 'mine', 'user', 'the user'])
const ASSISTANT_TERMS = new Set(['assistant', 'the assistant', 'you'])

/** First-person / generic-user surface forms that always mean the user anchor. A real NAME is NOT
 *  here — names link via alias/semantic match so we don't hard-code the user's name in two places. */
export function isUserRef(name: string): boolean {
  return USER_TERMS.has(normalizeName(name))
}

/** The assistant's own name, or a generic "assistant" term → the assistant anchor. */
export function isAssistantRef(name: string, assistantName: string): boolean {
  const n = normalizeName(name)
  return n === normalizeName(assistantName) || ASSISTANT_TERMS.has(n)
}

export interface ResolveCandidate {
  /** Normalized surface form of the proposed entity's name. */
  norm: string
  /** Embedding of the candidate (name + props), or null if unavailable. */
  vec: Float32Array | null
}

export interface ResolveTarget {
  id: string
  /** Normalized name + all known aliases. */
  surfaces: string[]
  embedding: Float32Array | null
}

export type Resolution = { link: string } | { create: true }

/**
 * Decide whether a proposed entity is an existing one (link) or genuinely new (create) — PURE, so the
 * caller does the IO (load/embed/write). Order, by descending precision:
 *   1. ALIAS match — candidate's normalized form is a known surface of an existing entity (exact).
 *   2. SEMANTIC match — nearest existing embedding with cosine ≥ threshold.
 *   3. CREATE — nothing matched.
 * Alias beats semantic (exact beats fuzzy); a strict threshold (≈0.88) avoids false fuses.
 */
export function resolve(
  cand: ResolveCandidate,
  existing: readonly ResolveTarget[],
  threshold: number,
): Resolution {
  for (const e of existing) {
    if (e.surfaces.includes(cand.norm)) return { link: e.id }
  }
  if (cand.vec) {
    let best: ResolveTarget | null = null
    let bestSim = -1
    for (const e of existing) {
      if (!e.embedding) continue
      const sim = cosineSimilarity(cand.vec, e.embedding)
      if (sim > bestSim) {
        bestSim = sim
        best = e
      }
    }
    if (best && bestSim >= threshold) return { link: best.id }
  }
  return { create: true }
}
