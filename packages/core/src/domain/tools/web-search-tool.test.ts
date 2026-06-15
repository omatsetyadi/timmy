import { describe, it, expect } from 'vitest'
import { Platform } from 'timmy-sdk'
import { parseSearch, parseExtract, buildWebSearchTool, buildFetchUrlTool } from './web-search-tool'

const ctx = {
  credentials: { get: async () => null },
  signal: new AbortController().signal,
  platform: Platform.MAC,
}

describe('parseSearch', () => {
  it('maps Tavily search json to answer + sources', () => {
    const raw = {
      answer: 'the answer',
      results: [
        { title: 'A', url: 'http://a', content: 'aaa' },
        { title: 'B', url: 'http://b', content: 'bbb' },
      ],
    }
    expect(parseSearch(raw)).toEqual({
      answer: 'the answer',
      sources: [
        { title: 'A', url: 'http://a', snippet: 'aaa' },
        { title: 'B', url: 'http://b', snippet: 'bbb' },
      ],
    })
  })
  it('tolerates missing answer/results', () => {
    expect(parseSearch({})).toEqual({ answer: '', sources: [] })
  })
})

describe('parseExtract', () => {
  it('returns the first result content', () => {
    expect(parseExtract({ results: [{ url: 'http://a', raw_content: 'page text' }] })).toEqual({
      url: 'http://a',
      content: 'page text',
    })
  })
  it('returns an error when nothing extracted', () => {
    expect(parseExtract({ failed_results: [{ url: 'http://a', error: 'boom' }] })).toEqual({
      error: 'boom',
    })
  })
})

const okPoster = (json: unknown) => async () => ({ ok: true, status: 200, json: async () => json })

describe('webSearch tool', () => {
  it('is safe-tier and named webSearch', () => {
    const t = buildWebSearchTool(async () => 'key', okPoster({}))
    expect(t.name).toBe('webSearch')
    expect(t.riskLevel).toBe('safe')
  })
  it('asks the user to set a key when none is stored', async () => {
    const r = await buildWebSearchTool(async () => null, okPoster({})).execute({ query: 'x' }, ctx)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/set-key/)
  })
  it('returns parsed answer + sources on success', async () => {
    const poster = okPoster({ answer: 'hi', results: [{ title: 'A', url: 'u', content: 'c' }] })
    const r = await buildWebSearchTool(async () => 'key', poster).execute({ query: 'x' }, ctx)
    expect(r.ok).toBe(true)
    expect(r.data).toEqual({ answer: 'hi', sources: [{ title: 'A', url: 'u', snippet: 'c' }] })
  })
  it('surfaces a non-200 as ok:false', async () => {
    const poster = async () => ({ ok: false, status: 401, json: async () => ({}) })
    const r = await buildWebSearchTool(async () => 'key', poster).execute({ query: 'x' }, ctx)
    expect(r.ok).toBe(false)
  })
})

describe('fetchUrl tool', () => {
  it('returns extracted page content', async () => {
    const poster = okPoster({ results: [{ url: 'u', raw_content: 'text' }] })
    const r = await buildFetchUrlTool(async () => 'key', poster).execute({ url: 'u' }, ctx)
    expect(r.ok).toBe(true)
    expect(r.data).toEqual({ url: 'u', content: 'text' })
  })
})
