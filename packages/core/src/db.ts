import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config'

export interface ThreadRow {
  id: string
  title: string | null
  created_at: string
  updated_at: string
}

export interface MessageRow {
  id: string
  thread_id: string
  role: string
  content: string
  created_at: string
}

let db: Database.Database

/** Open (and migrate) the SQLite database at ~/.timmy/timmy.db. */
export function initDb(path: string = join(CONFIG_DIR, 'timmy.db')): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      thread_id   TEXT NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
  `)
}

export function createThread(title: string | null = null): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    id,
    title,
    now,
    now,
  )
  return id
}

export function threadExists(id: string): boolean {
  return db.prepare('SELECT 1 FROM threads WHERE id = ?').get(id) !== undefined
}

export function addMessage(threadId: string, role: string, content: string): void {
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(randomUUID(), threadId, role, content, now)
  db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now, threadId)
}

export function getMessages(threadId: string): MessageRow[] {
  return db
    .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC')
    .all(threadId) as MessageRow[]
}

export function listThreads(): ThreadRow[] {
  return db.prepare('SELECT * FROM threads ORDER BY updated_at DESC').all() as ThreadRow[]
}

export function getThread(id: string): { thread: ThreadRow; messages: MessageRow[] } | null {
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined
  if (!thread) return null
  return { thread, messages: getMessages(id) }
}
