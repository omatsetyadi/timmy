import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, readConfigSync, effectiveProviders } from './config'

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

const writeCfg = (yaml: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-cfg-'))
  const path = join(dir, 'config.yaml')
  writeFileSync(path, yaml, 'utf8')
  return path
}

describe('config providers + reasoning', () => {
  it('parses a providers map and models.reasoning.default', () => {
    const path = writeCfg(`
models:
  frontdesk: { provider: ollama, model: qwen3:14b }
  reasoning: { default: deepseek/deepseek-v4-flash }
providers:
  ollama: { kind: ollama, base_url: http://localhost:11434 }
  deepseek: { kind: openai-compat, base_url: https://api.deepseek.com }
`)
    const cfg = readConfigSync(path)
    expect(cfg.models.reasoning?.default).toBe('deepseek/deepseek-v4-flash')
    expect(cfg.providers?.deepseek).toEqual({
      kind: 'openai-compat',
      base_url: 'https://api.deepseek.com',
    })
    expect(cfg.providers?.ollama.kind).toBe('ollama')
  })

  it('parses models.vision.default', () => {
    const path = writeCfg(
      `models:\n  frontdesk: { provider: ollama, model: qwen3:14b }\n  vision: { default: ollama/llava }\n`,
    )
    expect(readConfigSync(path).models.vision?.default).toBe('ollama/llava')
  })

  it('defaults: no providers/reasoning block → undefined, frontdesk still works', () => {
    const path = writeCfg(`models:\n  frontdesk: { provider: ollama, model: qwen3:14b }\n`)
    const cfg = readConfigSync(path)
    expect(cfg.providers).toBeUndefined()
    expect(cfg.models.reasoning).toBeUndefined()
    expect(cfg.models.frontdesk.model).toBe('qwen3:14b')
  })

  it('effectiveProviders adds an implicit ollama default; a declared ollama overrides it', () => {
    const noProviders = writeCfg(`models:\n  frontdesk: { provider: deepseek, model: x }\n`)
    expect(effectiveProviders(readConfigSync(noProviders)).ollama).toEqual({ kind: 'ollama' })

    const declared = writeCfg(
      `providers:\n  ollama: { kind: ollama, base_url: http://remote:11434 }\n`,
    )
    expect(effectiveProviders(readConfigSync(declared)).ollama.base_url).toBe('http://remote:11434')
  })

  it('parses claude_code model + bypass_permissions ("auto mode") toggle', () => {
    const path = writeCfg(`
providers:
  claude_code: { kind: claude-code, model: claude-opus-4-8, bypass_permissions: true }
`)
    const cfg = readConfigSync(path)
    expect(cfg.providers?.claude_code.model).toBe('claude-opus-4-8')
    expect(cfg.providers?.claude_code.bypass_permissions).toBe(true)
  })
})

describe('memory config', () => {
  it('defaults the memory block (learning on, notify on, preference always_kinds, recall_limit 5, recall_budget 15, search_limit 25, list_cap 200)', () => {
    const cfg = readConfigSync('/nonexistent/path/config.yaml') // missing file → DEFAULTS
    expect(cfg.memory).toEqual({
      learning_mode: true,
      notify_on_learn: true,
      always_kinds: [],
      recall_limit: 5,
      recall_budget: 15,
      search_limit: 25,
      list_cap: 200,
    })
  })
})

describe('assistant.voice_style', () => {
  it('defaults to the spoken-register fragment', () => {
    const cfg = readConfigSync('/nonexistent/path/config.yaml') // missing file → DEFAULTS
    expect(cfg.assistant.voice_style).toMatch(/speaking out loud/i)
  })

  it('a file override replaces the default', () => {
    const path = writeCfg(`assistant:\n  voice_style: "be brief out loud"\n`)
    expect(readConfigSync(path).assistant.voice_style).toBe('be brief out loud')
  })
})

describe('voice config', () => {
  it('defaults the voice block (stt empty, tts.engine local, wake.word hey_jarvis) when absent', () => {
    const cfg = readConfigSync('/nonexistent/path/config.yaml') // missing file → DEFAULTS
    expect(cfg.voice).toEqual({
      stt: {},
      tts: { engine: 'local' },
      wake: { word: 'hey_jarvis' },
      autostart: false,
      full_duplex: true,
      conversation: {
        smart_turn: true,
        smart_turn_threshold: 0.5,
        smart_turn_hard_cap_ms: 2500,
        end_silence_ms: 900,
        follow_up_secs: 12,
        first_listen_secs: 8,
      },
    })
  })

  it('parses full_duplex + conversation knobs and deep-merges partial conversation over defaults', () => {
    const path = writeCfg(`
voice:
  full_duplex: false
  conversation: { smart_turn_threshold: 0.7, follow_up_secs: 20 }
`)
    const v = readConfigSync(path).voice
    expect(v.full_duplex).toBe(false)
    expect(v.conversation.smart_turn_threshold).toBe(0.7) // set
    expect(v.conversation.follow_up_secs).toBe(20) // set
    expect(v.conversation.smart_turn).toBe(true) // default preserved
    expect(v.conversation.smart_turn_hard_cap_ms).toBe(2500) // default preserved
    expect(v.conversation.first_listen_secs).toBe(8) // default preserved
  })

  it('parses a full voice block (stt, tts + openai, wake)', () => {
    const path = writeCfg(`
voice:
  stt: { engine: faster-whisper, model: small }
  tts:
    engine: openai
    voice: bm_fable
    rate: 1.1
    openai: { model: gpt-4o-mini-tts, voice: ash, instructions: "warm, conversational" }
  wake: { word: hey_timmy }
`)
    const v = readConfigSync(path).voice
    expect(v.stt).toEqual({ engine: 'faster-whisper', model: 'small' })
    expect(v.tts.engine).toBe('openai')
    expect(v.tts.voice).toBe('bm_fable')
    expect(v.tts.rate).toBe(1.1)
    expect(v.tts.openai).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'ash',
      instructions: 'warm, conversational',
    })
    expect(v.wake.word).toBe('hey_timmy')
  })

  it('deep-merges a partial voice block over defaults (set one key, others keep defaults)', () => {
    const path = writeCfg(`voice:\n  tts: { voice: bm_fable }\n`)
    const v = readConfigSync(path).voice
    expect(v.tts.voice).toBe('bm_fable') // set
    expect(v.tts.engine).toBe('local') // default preserved through the merge
    expect(v.wake.word).toBe('hey_jarvis') // default preserved
  })
})

describe('permissions config', () => {
  it('defaults to { mode: default } when absent', () => {
    const path = writeCfg(`models:\n  frontdesk: { provider: ollama, model: qwen3:14b }\n`)
    expect(readConfigSync(path).permissions).toEqual({ mode: 'default' })
  })

  it('parses mode, plugin/tool overrides, and the command allowlist', () => {
    const path = writeCfg(`
permissions:
  mode: yolo
  plugins: { machine: ask }
  tools: { machine__deleteFile: block, runCommand: ask }
  commands:
    allow: [npm install, git commit]
`)
    const p = readConfigSync(path).permissions
    expect(p.mode).toBe('yolo')
    expect(p.plugins?.machine).toBe('ask')
    expect(p.tools?.machine__deleteFile).toBe('block')
    expect(p.commands?.allow).toEqual(['npm install', 'git commit'])
  })
})
