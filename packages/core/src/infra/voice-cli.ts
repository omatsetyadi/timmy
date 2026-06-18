import { load, dump } from 'js-yaml'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { CONFIG_DIR, CONFIG_PATH, readConfigSync, type VoiceConfig } from '../domain/config/config'
import {
  installVoice,
  preflight,
  startVoice,
  stopVoice,
  uninstallVoice,
  voiceLifecycleStatus,
  VOICE_PATHS,
} from './voice-lifecycle'

export type Raw = Record<string, unknown>

// The wake word is one trained .onnx model in a single canonical slot. Changing it = re-import
// (paste a new file → it replaces this one). No name picker, no activate, no switch.
const WAKEWORDS_DIR = join(CONFIG_DIR, 'voice', 'wakewords')
const WAKE_MODEL = join(WAKEWORDS_DIR, 'wake.tflite')
const TRAIN_URL = 'https://github.com/dscripka/openWakeWord  ("automatic model training" notebook)'

// ── pure mutation (unit-tested) ───────────────────────────────────────────────

/**
 * Return `raw` with `voice.<path>` set to `value`, creating nested objects as needed and leaving
 * every other key intact. Validates (engine ∈ local|openai, rate numeric) and throws on bad input.
 * `path`: `engine | speaker | rate | openai.<model|voice|instructions>`.
 */
export function applyVoiceEdit(raw: Raw, path: string, value: string): Raw {
  const voice = (raw.voice ??= {}) as { stt?: Raw; tts?: Raw; wake?: Raw }
  const tts = (voice.tts ??= {}) as { engine?: string; voice?: string; rate?: number; openai?: Raw }
  switch (path) {
    case 'engine':
      if (value !== 'local' && value !== 'openai')
        throw new Error(`engine must be 'local' or 'openai', got '${value}'`)
      tts.engine = value
      break
    case 'speaker':
      tts.voice = value
      break
    case 'rate': {
      const n = parseFloat(value)
      if (Number.isNaN(n)) throw new Error(`rate must be a number, got '${value}'`)
      tts.rate = n
      break
    }
    case 'openai.model':
    case 'openai.voice':
    case 'openai.instructions': {
      const field = path.slice('openai.'.length)
      const openai = (tts.openai ??= {}) as Raw
      openai[field] = value
      break
    }
    case 'wake.phrase': {
      // Display-only label for an imported custom model (the file is renamed to a generic slot,
      // so this records what it actually is). The daemon doesn't read it; status/UI does.
      const wake = (voice.wake ??= {}) as { word?: string; phrase?: string }
      wake.phrase = value
      break
    }
    default:
      throw new Error(`unknown voice setting '${path}'`)
  }
  return raw
}

// `voice.*` settings the system reads (the daemon's endpointing/turn-taking knobs, plus `autostart`
// which CORE reads). `conv: true` → lives under voice.conversation; otherwise directly under voice.
// `type` drives validation + coercion. Names ARE the contract; do not rename.
type Coerce = 'bool' | 'float' | 'int'
const VOICE_TUNABLES: Record<string, { conv: boolean; type: Coerce }> = {
  autostart: { conv: false, type: 'bool' },
  full_duplex: { conv: false, type: 'bool' },
  smart_turn: { conv: true, type: 'bool' },
  smart_turn_threshold: { conv: true, type: 'float' },
  smart_turn_hard_cap_ms: { conv: true, type: 'int' },
  end_silence_ms: { conv: true, type: 'int' },
  follow_up_secs: { conv: true, type: 'float' },
  first_listen_secs: { conv: true, type: 'float' },
}

export const VOICE_TUNABLE_KEYS = Object.keys(VOICE_TUNABLES)

const coerce = (type: Coerce, value: string): boolean | number => {
  switch (type) {
    case 'bool': {
      const v = value.toLowerCase()
      if (v === 'true' || v === 'on') return true
      if (v === 'false' || v === 'off') return false
      throw new Error(`expected true/false, got '${value}'`)
    }
    case 'float': {
      const n = parseFloat(value)
      if (Number.isNaN(n)) throw new Error(`expected a number, got '${value}'`)
      return n
    }
    case 'int': {
      const n = parseInt(value, 10)
      if (Number.isNaN(n)) throw new Error(`expected an integer, got '${value}'`)
      return n
    }
  }
}

/**
 * Return `raw` with a voice tuning knob (`full_duplex` or a `conversation.*` key) set to the coerced
 * `value`, creating nested objects as needed and leaving every other key intact. Throws on an unknown
 * key or a value that doesn't match the knob's type.
 */
export function applyVoiceTunable(raw: Raw, key: string, value: string): Raw {
  const spec = VOICE_TUNABLES[key]
  if (!spec)
    throw new Error(`unknown voice setting '${key}' (try: ${VOICE_TUNABLE_KEYS.join(', ')})`)
  const voice = (raw.voice ??= {}) as Raw
  const coerced = coerce(spec.type, value)
  if (spec.conv) {
    const conversation = (voice.conversation ??= {}) as Raw
    conversation[key] = coerced
  } else {
    voice[key] = coerced
  }
  return raw
}

/**
 * Validate + copy a trained `.onnx` into the single canonical wake slot, replacing any existing
 * model. Throws on a non-`.onnx` or missing source. Returns the destination. (The daemon loads
 * this file; if it is absent it falls back to the bundled pretrained word.)
 */
export function importWake(src: string): string {
  if (extname(src).toLowerCase() !== '.tflite')
    throw new Error(`wake model must be a .tflite file, got '${src}'`)
  if (!existsSync(src)) throw new Error(`no such file: ${src}`)
  mkdirSync(WAKEWORDS_DIR, { recursive: true })
  copyFileSync(src, WAKE_MODEL) // rename into the canonical slot + replace whatever was there
  return WAKE_MODEL
}

// ── yaml IO (mirrors model-cli / profile-cli; js-yaml normalizes, dropping comments) ──

const loadRaw = (): Raw => {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    const v = load(readFileSync(CONFIG_PATH, 'utf8'))
    return v && typeof v === 'object' ? (v as Raw) : {}
  } catch {
    return {}
  }
}
const saveRaw = (raw: Raw): void => {
  mkdirSync(CONFIG_DIR, { recursive: true }) // first write on a fresh install (no `timmy init` yet)
  writeFileSync(CONFIG_PATH, dump(raw), 'utf8')
}

const write = (path: string, value: string): void => saveRaw(applyVoiceEdit(loadRaw(), path, value))

// ── setters (called by the CLI; the daemon reads these exact config paths) ─────

export const setVoiceEngine = (engine: string): void => write('engine', engine)
export const setVoiceSpeaker = (name: string): void => write('speaker', name)
export const setVoiceRate = (rate: string): void => write('rate', rate)
export const setVoiceOpenai = (field: string, value: string): void =>
  write(`openai.${field}`, value)
export const setVoiceWakePhrase = (phrase: string): void => write('wake.phrase', phrase)
export const setVoiceTunable = (key: string, value: string): void =>
  saveRaw(applyVoiceTunable(loadRaw(), key, value))

/** The effective `voice` block (defaults merged with the file) — for `timmy voice status`. */
export const voiceStatus = (): VoiceConfig => readConfigSync().voice

// ── command ──────────────────────────────────────────────────────────────────

const USAGE =
  'Usage: timmy voice <install|start|stop|status|logs|uninstall|engine|speaker|rate|wake import|openai|set>'

const applied = (msg: string): void => console.log(`${msg}   (restart Timmy to apply)`)
const fail = (msg: string): never => {
  console.error(msg)
  process.exit(1)
}

/**
 * (Re)import the wake word — the ONLY way to change it. Two-step prompt over a SINGLE readline
 * interface (two interfaces on piped stdin would drop the second line): ① path to a trained
 * `.onnx` → replaces the canonical model; ② a display phrase (e.g. "hey timmy") stored as
 * `voice.wake.phrase`, since the file is renamed to a generic slot.
 */
async function wakeImport(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())))
  try {
    const src = await ask(
      'Paste the path to your trained .tflite wake-word model and press Enter\n' +
        `(don't have one? train it free, ~30 min, at ${TRAIN_URL}):\n`,
    )
    if (!src) {
      console.error('no path given')
      process.exitCode = 1
      return
    }
    importWake(src)
    const phrase = await ask('What does it say? A short phrase for the UI (e.g. "hey timmy"):\n')
    if (phrase) setVoiceWakePhrase(phrase)
    applied(
      phrase
        ? `wake model installed — “${phrase}” (replaced the previous one)`
        : 'wake model installed (replaced the previous one)',
    )
  } finally {
    rl.close()
  }
}

/** `timmy voice install` — preflight (no silent installs), then clone + uv sync after a y/N prompt. */
async function voiceInstallFlow(): Promise<void> {
  const pre = preflight()
  const mark = (ok: boolean): string => (ok ? '✓' : '✗')
  console.log('Timmy voice needs:')
  console.log(`  ${mark(pre.python)} Python 3.11+`)
  console.log(`  ${mark(pre.uv)} uv`)
  console.log('  ✗ voice daemon  (clone + uv sync into ~/.timmy/voice)')
  if (!pre.python)
    return fail('Install Python 3.11+ first (e.g. `brew install python@3.12`), then re-run.')
  if (!pre.uv)
    return fail('Install uv first: `curl -LsSf https://astral.sh/uv/install.sh | sh`, then re-run.')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ans = await new Promise<string>((resolve) =>
    rl.question('Install now? [y/N] ', (a) => resolve(a.trim().toLowerCase())),
  )
  rl.close()
  if (ans !== 'y' && ans !== 'yes') return void console.log('Cancelled.')
  const r = installVoice()
  if (r.ok) return void console.log('Voice installed.  Start it with: timmy voice start')
  if (r.reason === 'already-installed') return void console.log('Voice is already installed.')
  return fail(`Install failed (${r.reason}).`)
}

/** `timmy voice <install|start|stop|status|logs|uninstall|engine|speaker|rate|wake|openai|set>` —
 *  manage the voice daemon (lifecycle) + the `voice:` config block it reads. */
export async function voice(args: readonly string[]): Promise<void> {
  const sub = args[0]
  try {
    switch (sub) {
      case 'engine': {
        const v = args[1]
        if (!v) return fail('Usage: timmy voice engine <local|openai>')
        setVoiceEngine(v)
        return applied(`voice.tts.engine → ${v}`)
      }
      case 'speaker': {
        const v = args[1]
        if (!v) return fail('Usage: timmy voice speaker <name>   (local English Kokoro voice)')
        setVoiceSpeaker(v)
        return applied(`voice.tts.voice → ${v}`)
      }
      case 'rate': {
        const v = args[1]
        if (!v) return fail('Usage: timmy voice rate <float>   (e.g. 1.0)')
        setVoiceRate(v)
        return applied(`voice.tts.rate → ${v}`)
      }
      case 'wake':
        // `wake import` (re)imports the trained model — the only way to change the wake word.
        if (args[1] === 'import') return wakeImport()
        return fail('Usage: timmy voice wake import   ((re)import the trained .onnx wake model)')
      case 'openai': {
        const field = args[1]
        const value = args.slice(2).join(' ')
        if (!field || !value)
          return fail('Usage: timmy voice openai <voice|model|instructions> <value>')
        setVoiceOpenai(field, value)
        return applied(`voice.tts.openai.${field} → ${value}`)
      }
      case 'set': {
        // Turn-taking / endpointing knobs (full_duplex + conversation.*) the daemon reads.
        const key = args[1]
        const value = args.slice(2).join(' ')
        if (!key || value === '')
          return fail(
            `Usage: timmy voice set <key> <value>\n  keys: ${VOICE_TUNABLE_KEYS.join(', ')}`,
          )
        setVoiceTunable(key, value)
        return applied(`voice ${key} → ${value}`)
      }
      case 'install':
        return voiceInstallFlow()
      case 'autostart': {
        const v = args[1]
        if (v !== 'on' && v !== 'off') return fail('Usage: timmy voice autostart <on|off>')
        setVoiceTunable('autostart', v)
        return applied(`voice.autostart → ${v === 'on'} (core starts voice on launch)`)
      }
      case 'start': {
        const r = startVoice()
        if ('notInstalled' in r) return fail('Voice is not installed. Run: timmy voice install')
        if ('alreadyRunning' in r)
          return void console.log(`Voice already running (pid ${r.alreadyRunning}).`)
        return void console.log(`Voice started (pid ${r.started}).  Logs: timmy voice logs`)
      }
      case 'stop': {
        const r = stopVoice()
        return void console.log(
          'stopped' in r ? `Voice stopped (pid ${r.stopped}).` : 'Voice is not running.',
        )
      }
      case 'logs':
        if (!existsSync(VOICE_PATHS.logFile)) return void console.log('No voice logs yet.')
        return void process.stdout.write(readFileSync(VOICE_PATHS.logFile, 'utf8'))
      case 'uninstall':
        uninstallVoice()
        return void console.log('Voice stopped and removed (~/.timmy/voice).')
      case 'status': {
        const lc = voiceLifecycleStatus()
        console.log(`installed: ${lc.installed}`)
        console.log(lc.running ? `running:   yes (pid ${lc.running})` : 'running:   no')
        console.log('config:')
        return void console.log(JSON.stringify(voiceStatus(), null, 2))
      }
      default:
        return fail(USAGE)
    }
  } catch (e) {
    fail((e as Error).message)
  }
}
