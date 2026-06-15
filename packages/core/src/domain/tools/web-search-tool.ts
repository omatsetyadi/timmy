import type { Tool, ToolResult } from 'timmy-sdk'

/** Web search + page fetch, backed by Tavily (mirrors the workflow-engine capability).
 *  Core tools, `safe`-tier (read-only → auto-run). HTTP goes through an injectable poster so
 *  the tools are unit-testable with no network. */

export interface SearchResult {
  answer: string
  sources: { title: string; url: string; snippet: string }[]
}

interface RawSearch {
  answer?: string
  results?: { title?: string; url?: string; content?: string }[]
}
interface RawExtract {
  results?: { url?: string; raw_content?: string }[]
  failed_results?: { url?: string; error?: string }[]
}

/** Pure: Tavily /search json → answer + sources. */
export function parseSearch(raw: unknown): SearchResult {
  const r = (raw ?? {}) as RawSearch
  return {
    answer: r.answer ?? '',
    sources: (r.results ?? []).map((s) => ({
      title: s.title ?? '',
      url: s.url ?? '',
      snippet: (s.content ?? '').slice(0, 500),
    })),
  }
}

/** Pure: Tavily /extract json → page content, or an error. */
export function parseExtract(raw: unknown): { url: string; content: string } | { error: string } {
  const r = (raw ?? {}) as RawExtract
  const hit = r.results?.[0]
  if (hit?.raw_content !== undefined) return { url: hit.url ?? '', content: hit.raw_content }
  return { error: r.failed_results?.[0]?.error ?? 'no content extracted' }
}

/** Keychain account for the Tavily key (mirrors the `model:<p>:api_key` convention). */
export const TAVILY_KEY = 'search:tavily:api_key'

interface PostResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}
export type JsonPoster = (url: string, body: unknown) => Promise<PostResponse>

const defaultPoster: JsonPoster = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const NO_KEY = {
  ok: false as const,
  error: 'no Tavily API key — set one with: timmy search set-key tavily',
}

export function buildWebSearchTool(
  getKey: () => Promise<string | null>,
  post: JsonPoster = defaultPoster,
): Tool {
  return {
    name: 'webSearch',
    description:
      'Search the web for facts, news, docs, definitions, versions, prices — any quick "look it up" question. Returns an AI answer + top sources. Cheap; use for surface-level facts, not deep research.',
    riskLevel: 'safe',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'the search query' } },
      required: ['query'],
    },
    execute: async (args): Promise<ToolResult> => {
      const key = await getKey()
      if (!key) return NO_KEY
      try {
        const res = await post('https://api.tavily.com/search', {
          api_key: key,
          query: String(args.query ?? ''),
          search_depth: 'basic',
          max_results: 5,
          include_answer: true,
        })
        if (!res.ok) return { ok: false, error: `Tavily search failed: ${res.status}` }
        return { ok: true, data: parseSearch(await res.json()) }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

export function buildFetchUrlTool(
  getKey: () => Promise<string | null>,
  post: JsonPoster = defaultPoster,
): Tool {
  return {
    name: 'fetchUrl',
    description:
      'Fetch the full text content of a web page URL. Use when a search snippet is too thin, or the user gives you a URL to read.',
    riskLevel: 'safe',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'the URL to read' } },
      required: ['url'],
    },
    execute: async (args): Promise<ToolResult> => {
      const key = await getKey()
      if (!key) return NO_KEY
      try {
        const res = await post('https://api.tavily.com/extract', {
          api_key: key,
          urls: [String(args.url ?? '')],
          extract_depth: 'basic',
        })
        if (!res.ok) return { ok: false, error: `Tavily extract failed: ${res.status}` }
        const parsed = parseExtract(await res.json())
        return 'error' in parsed ? { ok: false, error: parsed.error } : { ok: true, data: parsed }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
