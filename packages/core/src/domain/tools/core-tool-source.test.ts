import { it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { expect } from 'vitest'
import type { Tool } from 'timmy-sdk'
import { ToolSource, mergeToolSources } from './tool-source'

const fakeTool = (name: string): Tool => ({
  name,
  description: '',
  parameters: { type: 'object' },
  riskLevel: 'safe',
  execute: async () => ({ ok: true }),
})

it.effect('mergeToolSources concatenates tools and unions credential scopes', () =>
  Effect.gen(function* () {
    const a = ToolSource.layer([fakeTool('askModel')])
    const b = Layer.succeed(ToolSource, {
      tools: [fakeTool('openApp')],
      credentialScopeByTool: new Map([['openApp', { plugin: 'machine', keys: [] }]]),
    })
    const merged = mergeToolSources(a, b)
    const src = yield* ToolSource.pipe(Effect.provide(merged))
    expect(src.tools.map((t) => t.name).sort()).toEqual(['askModel', 'openApp'])
    expect(src.credentialScopeByTool.get('openApp')?.plugin).toBe('machine')
  }),
)
