import { describe, it, expect } from 'vitest'
import { Platform } from 'timmy-sdk'
import { mimeFromPath, visionRequest, parseVisionResponse, buildAskVisionTool } from './vision'
import type { ProviderTarget } from '../llm/provider'

const ctx = {
  credentials: { get: async () => null },
  signal: new AbortController().signal,
  platform: Platform.MAC,
}
const ollama: ProviderTarget = {
  providerKey: 'ollama',
  kind: 'ollama',
  model: 'llava',
  baseUrl: 'http://localhost:11434',
}
const cloud: ProviderTarget = {
  providerKey: 'gemini',
  kind: 'openai-compat',
  model: 'gemini-vision',
  baseUrl: 'https://api.x.com',
}
const img = { b64: 'BASE64', mime: 'image/png' }

describe('mimeFromPath', () => {
  it('maps extensions to mime types', () => {
    expect(mimeFromPath('/a/b.png')).toBe('image/png')
    expect(mimeFromPath('/a/b.JPG')).toBe('image/jpeg')
    expect(mimeFromPath('/a/b.jpeg')).toBe('image/jpeg')
    expect(mimeFromPath('/a/b.webp')).toBe('image/webp')
  })
})

describe('visionRequest', () => {
  it('defaults the Ollama base URL to localhost when the target has none', () => {
    const noBase = { ...ollama, baseUrl: undefined }
    expect(visionRequest(noBase, 'q', img).url).toBe('http://localhost:11434/api/chat')
  })
  it('builds an Ollama /api/chat request with images[]', () => {
    const { url, body } = visionRequest(ollama, 'what is this', img)
    expect(url).toBe('http://localhost:11434/api/chat')
    expect(body).toEqual({
      model: 'llava',
      messages: [{ role: 'user', content: 'what is this', images: ['BASE64'] }],
      stream: false,
    })
  })
  it('builds an openai-compat /chat/completions request with an image_url data URL', () => {
    const { url, body } = visionRequest(cloud, 'what is this', img)
    expect(url).toBe('https://api.x.com/chat/completions')
    expect(body).toEqual({
      model: 'gemini-vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,BASE64' } },
          ],
        },
      ],
    })
  })
})

describe('parseVisionResponse', () => {
  it('reads ollama message.content and openai choices[0].message.content', () => {
    expect(parseVisionResponse('ollama', { message: { content: 'a cat' } })).toBe('a cat')
    expect(
      parseVisionResponse('openai-compat', { choices: [{ message: { content: 'a dog' } }] }),
    ).toBe('a dog')
  })
})

const okPost = (json: unknown) => async () => ({ ok: true, status: 200, json: async () => json })

const deps = (over: Partial<Parameters<typeof buildAskVisionTool>[0]> = {}) =>
  buildAskVisionTool({
    resolveTarget: (id) => (id === 'ollama/llava' ? ollama : null),
    getKey: async () => 'key',
    findVisionTarget: async () => 'ollama/llava',
    readImage: async () => img,
    post: okPost({ message: { content: 'a yellow ranger' } }),
    ...over,
  })

describe('askVision tool', () => {
  it('is safe-tier and named askVision', () => {
    const t = deps()
    expect(t.name).toBe('askVision')
    expect(t.riskLevel).toBe('safe')
  })
  it('explains when no vision-capable model is available', async () => {
    const r = await deps({ findVisionTarget: async () => null }).execute({ path: '/x.png' }, ctx)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/vision/)
  })
  it('returns the model answer for a valid image + target', async () => {
    const r = await deps().execute({ path: '/x.png', prompt: 'what is this' }, ctx)
    expect(r).toEqual({ ok: true, data: 'a yellow ranger' })
  })
  it('fails clearly when the resolved target is unknown', async () => {
    const r = await deps({ findVisionTarget: async () => 'mystery/x' }).execute(
      { path: '/x.png' },
      ctx,
    )
    expect(r.ok).toBe(false)
  })
})
