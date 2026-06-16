export interface Migration {
  version: number
  sql: string
}

/** Ordered, append-only. `001` = the original threads/messages schema (was the interim bootstrap),
 *  `002` = the memory entity graph. RAG (Phase 6) appends `003`. Never edit a shipped migration. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
        properties TEXT, embedding BLOB, confidence REAL DEFAULT 0.7,
        source TEXT, last_updated TEXT NOT NULL, expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_entities_kind_name ON entities(kind, name);
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY, from_entity TEXT NOT NULL, relation TEXT NOT NULL,
        to_entity TEXT NOT NULL, properties TEXT, weight REAL DEFAULT 1.0, created_at TEXT NOT NULL,
        FOREIGN KEY (from_entity) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (to_entity) REFERENCES entities(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity);
    `,
  },
]

/** Migrations newer than the DB's current `user_version`, in order. Pure. */
export function pendingMigrations(current: number, all: Migration[]): Migration[] {
  return all.filter((m) => m.version > current).sort((a, b) => a.version - b.version)
}
