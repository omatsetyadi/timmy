import { describe, it, expect } from 'vitest'
import { toOllamaMessages, type ChatMessage } from './llm-client'
import { toOpenAiMessages } from './provider'

const dataUrl = 'data:image/png;base64,QUJD'
const userWithImage: ChatMessage = { role: 'user', content: 'what is this?', images: [dataUrl] }

describe('toOllamaMessages with images', () => {
  it('puts raw base64 (no data-url prefix) in the message images[]', () => {
    expect(toOllamaMessages([userWithImage])).toEqual([
      { role: 'user', content: 'what is this?', images: ['QUJD'] },
    ])
  })
  it('leaves a plain message unchanged', () => {
    expect(toOllamaMessages([{ role: 'user', content: 'hi' }])).toEqual([
      { role: 'user', content: 'hi' },
    ])
  })
})

describe('toOpenAiMessages with images', () => {
  it('builds multimodal content parts (text + image_url data URL)', () => {
    expect(toOpenAiMessages([userWithImage])).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ])
  })
  it('leaves a plain message as a string content', () => {
    expect(toOpenAiMessages([{ role: 'user', content: 'hi' }])).toEqual([
      { role: 'user', content: 'hi' },
    ])
  })
})
