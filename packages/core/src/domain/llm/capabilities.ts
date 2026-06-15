import type { ProviderKind } from '../config/config'
import type { DetectedCapabilities } from './llm-client'

const NONE: DetectedCapabilities = { vision: false, audio: false, tools: false, realtime: false }

/** Pure: map Ollama `/api/show` `capabilities` tags (e.g. ["completion","vision","tools"]) →
 *  DetectedCapabilities. This is the real, model-specific source (unlike the static cloud map). */
export function ollamaCapsFromShow(capabilities: readonly string[]): DetectedCapabilities {
  return {
    vision: capabilities.includes('vision'),
    audio: capabilities.includes('audio'),
    tools: capabilities.includes('tools'),
    realtime: false,
  }
}

/** Live capability resolution: Ollama reports real tags via `/api/show`; cloud/claude fall back
 *  to the static {@link capabilitiesFor} map (their APIs expose no probe). Degrades to NONE. */
export async function resolveModelCapabilities(
  kind: ProviderKind,
  model: string,
  baseUrl: string | undefined,
): Promise<DetectedCapabilities> {
  if (kind !== 'ollama') return capabilitiesFor(model)
  try {
    const res = await fetch(`${baseUrl ?? 'http://localhost:11434'}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: model }),
    })
    if (!res.ok) return NONE
    const data = (await res.json()) as { capabilities?: string[] }
    return ollamaCapsFromShow(data.capabilities ?? [])
  } catch {
    return NONE
  }
}

/** Static capability lookup by model family — used for cloud + claude-code providers,
 *  which (unlike Ollama's `/api/show`) expose no capability probe. Match by prefix. */
export const capabilitiesFor = (model: string): DetectedCapabilities => {
  const m = model.toLowerCase()
  if (m.startsWith('claude')) return { vision: true, audio: false, tools: true, realtime: false }
  if (m.startsWith('gpt-4o') || m.startsWith('gpt-4.') || m.startsWith('o1') || m.startsWith('o3'))
    return { vision: true, audio: false, tools: true, realtime: false }
  if (m.startsWith('gemini')) return { vision: true, audio: true, tools: true, realtime: true }
  if (m.startsWith('deepseek')) return { vision: false, audio: false, tools: true, realtime: false }
  return NONE
}
