import type { DetectedCapabilities, Message, ModelProvider } from 'timmy-sdk'

/**
 * Ollama frontdesk provider — talks to the native Ollama API (`/api/chat`,
 * `/api/tags`, `/api/show`) on the local daemon. Streaming chat via
 * newline-delimited JSON.
 */
export class OllamaProvider implements ModelProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async *chat(messages: Message[]): AsyncIterableIterator<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // think:false keeps reasoning tokens out of the streamed reply
      body: JSON.stringify({ model: this.model, messages, stream: true, think: false }),
    })
    if (!res.ok || !res.body) {
      throw new Error(`Ollama chat failed: ${res.status} ${res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const json = JSON.parse(line) as { message?: { content?: string }; done?: boolean }
        if (json.message?.content) yield json.message.content
        if (json.done) return
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`)
      return res.ok
    } catch {
      return false
    }
  }

  async detectCapabilities(): Promise<DetectedCapabilities> {
    try {
      const res = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model }),
      })
      const data = (await res.json()) as { capabilities?: string[] }
      const caps = data.capabilities ?? []
      return {
        tools: caps.includes('tools'),
        vision: caps.includes('vision'),
        audio: false,
        realtime: false,
      }
    } catch {
      return { tools: false, vision: false, audio: false, realtime: false }
    }
  }
}
