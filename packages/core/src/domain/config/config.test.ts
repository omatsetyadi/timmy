import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config'

it.effect('uses defaults when no file exists', () =>
  Effect.gen(function* () {
    const cfg = yield* Config
    const c = yield* cfg.get
    expect(c.server.port).toBe(3737)
    expect(c.models.frontdesk.model).toBe('qwen3:14b')
  }).pipe(Effect.provide(Config.Live(join(tmpdir(), 'does-not-exist.yaml')))),
)

it.effect('merges a partial file over defaults', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'timmy-')), 'config.yaml')
  writeFileSync(path, 'server:\n  port: 4040\n')
  return Effect.gen(function* () {
    const c = yield* (yield* Config).get
    expect(c.server.port).toBe(4040)
    expect(c.server.host).toBe('127.0.0.1') // default preserved
  }).pipe(Effect.provide(Config.Live(path)))
})
