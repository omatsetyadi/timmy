import { Effect, Stream } from 'effect'
import type { Tool, ToolResult } from 'timmy-sdk'
import type { ProviderTarget } from '../llm/provider'
import type { StreamChunk } from '../llm/stream-chunk'

export const parseTargetId = (id: string): { providerKey: string; model: string } | null => {
  const i = id.indexOf('/')
  if (i <= 0 || i === id.length - 1) return null
  return { providerKey: id.slice(0, i), model: id.slice(i + 1) }
}

export interface AskModelDeps {
  /** target id → resolved target (kind + baseUrl), or null if not configured. */
  resolveTarget: (id: string) => ProviderTarget | null
  /** keychain key getter for openai-compat providers. */
  getKey: (providerKey: string) => Promise<string | null>
  /** run a prompt against a fully-resolved target (NO tools); returns the chunk stream. */
  runChat: (target: ProviderTarget, prompt: string) => Stream.Stream<StreamChunk, unknown>
  /** the configured default target id, or null. */
  defaultTargetId: () => string | null
  /** current discovered pool ids (for the tool description). */
  poolIds: () => readonly string[]
}

const PARAMS = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      description: 'which model to consult, as "<provider>/<model>" (omit to use the default)',
    },
    prompt: {
      type: 'string',
      description: 'the self-contained task/question for the consulted model',
    },
  },
  required: ['prompt'],
}

export const buildAskModelTool = (deps: AskModelDeps): Tool => {
  const ids = deps.poolIds()
  const list = ids.length
    ? ids.join(', ')
    : '(none discovered yet — name a provider/model you configured)'
  return {
    name: 'askModel',
    description:
      `Consult a more capable model for hard reasoning, then answer in your own voice. ` +
      `Available targets: ${list}. Pass target as "<provider>/<model>", or omit to use the default.`,
    parameters: PARAMS,
    riskLevel: 'safe',
    execute: async (args, ctx): Promise<ToolResult> => {
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      if (!prompt.trim()) return { ok: false, error: 'askModel: prompt is required' }
      const id = (typeof args.target === 'string' && args.target) || deps.defaultTargetId()
      if (!id)
        return {
          ok: false,
          error: 'askModel: no target given and no models.reasoning.default configured',
        }
      const target = deps.resolveTarget(id)
      if (!target)
        return {
          ok: false,
          error: `askModel: target '${id}' not configured — run \`timmy model set-key <provider>\` and check the provider/model name`,
        }

      const apiKey = target.kind === 'openai-compat' ? await deps.getKey(target.providerKey) : null
      if (target.kind === 'openai-compat' && !apiKey)
        return {
          ok: false,
          error: `askModel: '${target.providerKey}' has no API key — run \`timmy model set-key ${target.providerKey}\``,
        }

      const resolved: ProviderTarget = { ...target, apiKey: apiKey ?? undefined }
      const collect = deps.runChat(resolved, prompt).pipe(
        Stream.runFold(
          {
            text: '',
            usage: undefined as { promptTokens: number; completionTokens: number } | undefined,
          },
          (acc, c: StreamChunk) =>
            c.type === 'content'
              ? { ...acc, text: acc.text + c.content }
              : c.type === 'usage'
                ? {
                    ...acc,
                    usage: { promptTokens: c.promptTokens, completionTokens: c.completionTokens },
                  }
                : acc,
        ),
        Effect.map(
          (acc) =>
            ({ ok: true, data: { text: acc.text, usage: acc.usage, target: id } }) as ToolResult,
        ),
        Effect.catchAll((e) =>
          Effect.succeed({ ok: false, error: `askModel: ${String(e)}` } as ToolResult),
        ),
      )
      return Effect.runPromise(collect, { signal: ctx.signal })
    },
  }
}
