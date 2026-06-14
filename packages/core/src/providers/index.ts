import type { ModelProvider } from 'timmy-sdk'
import type { TimmyConfig } from '../config'
import { OllamaProvider } from './ollama'

/**
 * Build the frontdesk (always-on orchestrator) provider from config.
 * Phase 2 implements Ollama; cloud providers (openai/anthropic/gemini/deepseek)
 * plug in here as follow-ups.
 */
export function createFrontdeskProvider(config: TimmyConfig): ModelProvider {
  const fd = config.models.frontdesk
  switch (fd.provider) {
    case 'ollama':
      return new OllamaProvider(fd.base_url ?? 'http://localhost:11434', fd.model)
    default:
      throw new Error(
        `Frontdesk provider "${fd.provider}" is not implemented yet. ` +
          `Phase 2 ships Ollama; openai/anthropic/gemini/deepseek are follow-ups.`,
      )
  }
}
