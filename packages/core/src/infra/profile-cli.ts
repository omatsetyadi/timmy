import { load, dump } from 'js-yaml'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR, CONFIG_PATH, readConfigSync } from '../domain/config/config'

export type Raw = Record<string, unknown>

/** The two config sections the profile command edits, and the fields valid in each.
 *  `assistant.*` = the agent itself; `user.*` = the human. All user-authored — the agent
 *  never writes them (distinct from the auto-learned memory graph). */
const SECTION_FIELDS = {
  assistant: ['name', 'personality'],
  user: ['name', 'about', 'style'],
} as const
type Section = keyof typeof SECTION_FIELDS
type Field = (typeof SECTION_FIELDS)[Section][number]

// ── pure mutation (unit-tested) ───────────────────────────────────────────────

/**
 * Return a new raw-config with `section.field` set to `value` (or removed when `value` is null),
 * preserving every other key. An emptied section is dropped entirely.
 */
export function applyProfileEdit(
  raw: Raw,
  section: Section,
  field: Field,
  value: string | null,
): Raw {
  const current: Raw = { ...((raw[section] as Raw | undefined) ?? {}) }
  if (value === null) delete current[field]
  else current[field] = value
  if (Object.keys(current).length === 0) {
    const rest = { ...raw }
    delete rest[section]
    return rest
  }
  return { ...raw, [section]: current }
}

/** The nested `assistant.language` sub-fields the CLI can edit. */
export const LANGUAGE_SUBFIELDS = ['conversation', 'proactive', 'supported'] as const
export type LanguageSubfield = (typeof LANGUAGE_SUBFIELDS)[number]

interface LanguageBlock {
  conversation?: string
  proactive?: string
  supported?: string[]
}

/**
 * Return a new raw-config with `assistant.language.<subfield>` set (or removed when null),
 * preserving the other assistant fields. An emptied language drops the key; an emptied
 * assistant section is removed entirely. `supported` carries an array; the rest carry strings.
 */
export function applyLanguageEdit(
  raw: Raw,
  subfield: LanguageSubfield,
  value: string | string[] | null,
): Raw {
  const assistant: Raw = { ...((raw.assistant as Raw | undefined) ?? {}) }
  const language: Raw = { ...((assistant.language as Raw | undefined) ?? {}) }
  if (value === null) delete language[subfield]
  else language[subfield] = value
  if (Object.keys(language).length === 0) delete assistant.language
  else assistant.language = language
  if (Object.keys(assistant).length === 0) {
    const rest = { ...raw }
    delete rest.assistant
    return rest
  }
  return { ...raw, assistant }
}

/** Human-readable dump of both sections (used by `timmy profile show`). */
export function formatProfile(
  assistant: { name?: string; personality?: string; language?: LanguageBlock },
  user: { name?: string; about?: string; style?: string },
): string {
  const v = (s?: string) => (s && s.trim() ? s : '(unset)')
  const lang = assistant.language
  const langLine = lang
    ? `conversation=${v(lang.conversation)}, proactive=${v(lang.proactive)}, supported=[${(lang.supported ?? []).join(', ')}]`
    : '(unset)'
  return [
    'Assistant (it):',
    `  name       : ${v(assistant.name)}`,
    `  personality: ${v(assistant.personality)}`,
    `  language   : ${langLine}`,
    'You (the user):',
    `  name       : ${v(user.name)}`,
    `  about      : ${v(user.about)}`,
    `  style      : ${v(user.style)}`,
  ].join('\n')
}

// ── yaml IO (mirrors memory-cli / model-cli; js-yaml normalizes, dropping comments) ──

const loadRaw = (): Raw => {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    const parsed = load(readFileSync(CONFIG_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Raw) : {}
  } catch {
    return {}
  }
}
const saveRaw = (raw: Raw): void => {
  mkdirSync(CONFIG_DIR, { recursive: true }) // first write on a fresh install (no `timmy init` yet)
  writeFileSync(CONFIG_PATH, dump(raw), 'utf8')
}

const writeField = (section: Section, field: Field, value: string | null): void =>
  saveRaw(applyProfileEdit(loadRaw(), section, field, value))

/** Open $EDITOR (fallback: vi) on a temp file seeded with `seed`; return the saved text. */
function editInEditor(seed: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-profile-'))
  const file = join(dir, 'profile.txt')
  try {
    writeFileSync(file, seed, 'utf8')
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi'
    execFileSync(editor, [file], { stdio: 'inherit', shell: false })
    return readFileSync(file, 'utf8').trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── command ──────────────────────────────────────────────────────────────────

const isSection = (s: string | undefined): s is Section => s === 'assistant' || s === 'user'
const isField = (section: Section, f: string | undefined): f is Field =>
  (SECTION_FIELDS[section] as readonly string[]).includes(f ?? '')

const USAGE =
  'Usage: timmy profile <show | set <assistant|user> <field> <text…> | edit <assistant|user> <field> | clear <assistant|user> <field>>\n' +
  '  assistant fields: name, personality, language <conversation|proactive|supported>\n' +
  '  user fields: name, about, style'

const LANG_USAGE =
  'Usage: timmy profile <set|clear> assistant language <conversation|proactive|supported> [value]\n' +
  '  conversation/proactive: a language (or "auto" for conversation)   supported: comma list, e.g. en,id,ja'

const fail = (msg: string): never => {
  console.error(msg)
  process.exit(1)
}

const isLangSub = (s: string | undefined): s is LanguageSubfield =>
  (LANGUAGE_SUBFIELDS as readonly string[]).includes(s ?? '')

/** Handle `profile <set|clear> assistant language <subfield> [value]`. `supported` is a comma list. */
function editLanguage(verb: 'set' | 'clear', args: readonly string[]): void {
  const subfield = args[3]
  if (!isLangSub(subfield)) return fail(LANG_USAGE)

  if (verb === 'clear') {
    saveRaw(applyLanguageEdit(loadRaw(), subfield, null))
    console.log(`assistant.language.${subfield} cleared   (restart Timmy to apply)`)
    return
  }

  if (subfield === 'supported') {
    const langs = args
      .slice(4)
      .join(' ')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (langs.length === 0) return fail(LANG_USAGE)
    saveRaw(applyLanguageEdit(loadRaw(), 'supported', langs))
    console.log(`assistant.language.supported → [${langs.join(', ')}]   (restart Timmy to apply)`)
    return
  }

  const value = args.slice(4).join(' ').trim()
  if (!value) return fail(LANG_USAGE)
  saveRaw(applyLanguageEdit(loadRaw(), subfield, value))
  console.log(`assistant.language.${subfield} → ${value}   (restart Timmy to apply)`)
}

/** `timmy profile <show|set|edit|clear>` — manage the assistant's identity + the user's profile,
 *  both injected into every system prompt. Config-only (no DB/runtime). */
export function profile(args: readonly string[]): void {
  const sub = args[0]

  if (sub === 'show' || sub === undefined) {
    const cfg = readConfigSync()
    console.log(
      formatProfile(
        {
          name: cfg.assistant.name,
          personality: cfg.assistant.personality,
          language: cfg.assistant.language,
        },
        { name: cfg.user?.name, about: cfg.user?.about, style: cfg.user?.style },
      ),
    )
    return
  }

  const section = args[1]
  if (!isSection(section)) return fail(USAGE)

  // `assistant.language.<subfield>` is nested — handle it before the flat-field path.
  if (section === 'assistant' && args[2] === 'language' && (sub === 'set' || sub === 'clear')) {
    return editLanguage(sub, args)
  }

  const field = args[2]
  if (!isField(section, field)) return fail(USAGE)

  if (sub === 'set') {
    const value = args.slice(3).join(' ').trim()
    if (!value) return fail(`Usage: timmy profile set ${section} ${field} <text…>`)
    writeField(section, field, value)
    console.log(`${section}.${field} → ${value}   (restart Timmy to apply)`)
    return
  }

  if (sub === 'clear') {
    writeField(section, field, null)
    console.log(`${section}.${field} cleared   (restart Timmy to apply)`)
    return
  }

  if (sub === 'edit') {
    const cfg = readConfigSync()
    const current =
      section === 'assistant'
        ? field === 'personality'
          ? cfg.assistant.personality
          : cfg.assistant.name
        : (cfg.user?.[field as 'name' | 'about' | 'style'] ?? '')
    const next = editInEditor(current)
    writeField(section, field, next || null)
    console.log(`${section}.${field} ${next ? 'updated' : 'cleared'}   (restart Timmy to apply)`)
    return
  }

  fail(USAGE)
}
