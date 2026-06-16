import type { Entity } from './types'

/** Union two property bags; on a key conflict, `bWins` decides which value survives. */
export function mergeProperties(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  bWins: boolean,
): Record<string, unknown> {
  return bWins ? { ...a, ...b } : { ...b, ...a }
}

/** Merge B into A: keep A.id, union properties (newer/higher-confidence wins), max confidence,
 *  latest lastUpdated. Relation rewiring is the store's job (EntityStore.merge). */
export function mergeEntities(a: Entity, b: Entity): Entity {
  const bWins =
    b.confidence > a.confidence || (b.confidence === a.confidence && b.lastUpdated > a.lastUpdated)
  return {
    ...a,
    properties: mergeProperties(a.properties, b.properties, bWins),
    confidence: Math.max(a.confidence, b.confidence),
    lastUpdated: a.lastUpdated > b.lastUpdated ? a.lastUpdated : b.lastUpdated,
  }
}
