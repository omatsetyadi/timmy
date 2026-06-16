export interface Entity {
  id: string
  kind: string
  name: string
  properties: Record<string, unknown>
  embedding?: Float32Array | null
  confidence: number
  source: 'conversation' | 'manual' | 'integration'
  lastUpdated: string
  expiresAt?: string | null
}

export interface Relation {
  id: string
  from: string // entity id
  relation: string
  to: string // entity id
  properties?: Record<string, unknown>
  weight: number
  createdAt: string
}

export interface ExtractedGraph {
  entities: { kind: string; name: string; properties?: Record<string, unknown> }[]
  relations: { from: string; relation: string; to: string; properties?: Record<string, unknown> }[]
}
