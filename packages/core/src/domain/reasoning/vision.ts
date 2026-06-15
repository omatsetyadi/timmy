import type { Tool, ToolResult } from 'timmy-sdk'
import type { ProviderKind } from '../config/config'
import type { ProviderTarget } from '../llm/provider'

/** `askVision` — hand a local image to a vision-capable model and return its text answer.
 *  Routes to a configured vision target (`models.vision.default`), like askModel routes to a
 *  reasoning target. Supports Ollama (local llava/qwen2-vl) and openai-compat (Gemini/GPT-4o…).
 *  A `safe`-tier core tool. HTTP + image-read are injected so it unit-tests with no fs/network. */

export interface VisionImage {
  b64: string
  mime: string
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

/** Best-effort mime from the file extension; defaults to jpeg. */
export function mimeFromPath(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : ''
  return MIME_BY_EXT[ext] ?? 'image/jpeg'
}

/** Pure: build the multimodal request for the target's provider kind. */
export function visionRequest(
  target: ProviderTarget,
  prompt: string,
  image: VisionImage,
): { url: string; body: unknown } {
  if (target.kind === 'ollama') {
    // Ollama isn't in the known-cloud-URL map, so an implicit Ollama target has no baseUrl —
    // default to localhost (matching makeOllamaClient) instead of building `undefined/api/chat`.
    const base = target.baseUrl ?? 'http://localhost:11434'
    return {
      url: `${base}/api/chat`,
      body: {
        model: target.model,
        messages: [{ role: 'user', content: prompt, images: [image.b64] }],
        stream: false,
      },
    }
  }
  return {
    url: `${target.baseUrl}/chat/completions`,
    body: {
      model: target.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.b64}` } },
          ],
        },
      ],
    },
  }
}

interface OllamaChat {
  message?: { content?: string }
}
interface OpenAiChat {
  choices?: { message?: { content?: string } }[]
}

/** Pure: pull the assistant text out of the provider's response shape. */
export function parseVisionResponse(kind: ProviderKind, json: unknown): string {
  if (kind === 'ollama') return (json as OllamaChat).message?.content ?? ''
  return (json as OpenAiChat).choices?.[0]?.message?.content ?? ''
}

interface PostResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

export interface AskVisionDeps {
  resolveTarget: (id: string) => ProviderTarget | null
  getKey: (provider: string) => Promise<string | null>
  /** The vision model to use: the explicit `models.vision.default`, else an auto-picked
   *  vision-capable model from the discovered pool, else null (none available). */
  findVisionTarget: () => Promise<string | null>
  readImage: (path: string) => Promise<VisionImage>
  post: (url: string, headers: Record<string, string>, body: unknown) => Promise<PostResponse>
}

const DEFAULT_PROMPT = 'Describe this image.'

export function buildAskVisionTool(deps: AskVisionDeps): Tool {
  return {
    name: 'askVision',
    description:
      'Look at a local image file and answer a question about it (what it shows, text in it, etc.). Routes to a configured vision-capable model. Provide the image path.',
    riskLevel: 'safe',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'absolute path to the local image file' },
        prompt: { type: 'string', description: 'what to ask about the image (optional)' },
      },
      required: ['path'],
    },
    execute: async (args): Promise<ToolResult> => {
      const id = await deps.findVisionTarget()
      if (!id) {
        return {
          ok: false,
          error:
            'no vision-capable model available — pull one (e.g. `ollama pull qwen2.5-vl`) or add a cloud vision model, then `timmy model vision <provider>/<model>` (see `timmy model list`)',
        }
      }
      const target = deps.resolveTarget(id)
      if (!target) return { ok: false, error: `vision target '${id}' is not an available model` }
      const path = String(args.path ?? '')
      if (!path) return { ok: false, error: 'path is required' }
      const prompt = typeof args.prompt === 'string' && args.prompt ? args.prompt : DEFAULT_PROMPT
      try {
        const image = await deps.readImage(path)
        const { url, body } = visionRequest(target, prompt, image)
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (target.kind === 'openai-compat') {
          const key = await deps.getKey(target.providerKey)
          if (key) headers.authorization = `Bearer ${key}`
        }
        const res = await deps.post(url, headers, body)
        if (!res.ok) {
          // The most common cause is pointing vision at a non-multimodal model.
          return {
            ok: false,
            error: `vision request failed (${res.status}) — is '${id}' vision-capable? check \`timmy model list\``,
          }
        }
        return { ok: true, data: parseVisionResponse(target.kind, await res.json()) }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
