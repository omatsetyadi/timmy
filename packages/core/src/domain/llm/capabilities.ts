import type { DetectedCapabilities } from './llm-client'

const NONE: DetectedCapabilities = { vision: false, audio: false, tools: false, realtime: false }

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
