import { load, dump } from 'js-yaml'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { CONFIG_PATH, type Permission, type PermissionMode } from '../domain/config/config'

type Raw = Record<string, unknown>

interface PermBlock {
  mode?: PermissionMode
  plugins?: Record<string, Permission>
  tools?: Record<string, Permission>
  commands?: { allow?: string[] }
}

const permsOf = (raw: Raw): PermBlock => (raw.permissions as PermBlock | undefined) ?? {}

// ── pure transformers (unit-tested) ─────────────────────────────────────────
export function applyMode(raw: Raw, mode: PermissionMode): Raw {
  return { ...raw, permissions: { ...permsOf(raw), mode } }
}

export function applyOverride(
  raw: Raw,
  kind: 'tool' | 'plugin',
  name: string,
  perm: Permission,
): Raw {
  const p = permsOf(raw)
  if (kind === 'tool') return { ...raw, permissions: { ...p, tools: { ...p.tools, [name]: perm } } }
  return { ...raw, permissions: { ...p, plugins: { ...p.plugins, [name]: perm } } }
}

export function applyAllowedCommand(raw: Raw, signature: string): Raw {
  const p = permsOf(raw)
  const allow = p.commands?.allow ?? []
  if (allow.includes(signature)) return raw
  return {
    ...raw,
    permissions: { ...p, commands: { ...p.commands, allow: [...allow, signature] } },
  }
}

/** A shell command's allowlist signature: program + a bare subcommand (drop flags/paths/args),
 *  so allowing `git commit` covers `git commit -m "..."` but not `git push`. */
export function commandSignature(command: string): string {
  const tokens = command.trim().split(/\s+/)
  const prog = tokens[0] ?? ''
  const sub = tokens[1]
  return sub && /^[a-z][a-z0-9:-]*$/i.test(sub) ? `${prog} ${sub}` : prog
}

// ── IO wrappers (js-yaml normalizes the file — drops comments, as in model-cli) ──
const loadRaw = (): Raw => {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    const v = load(readFileSync(CONFIG_PATH, 'utf8'))
    return v && typeof v === 'object' ? (v as Raw) : {}
  } catch {
    return {}
  }
}
const saveRaw = (raw: Raw): void => writeFileSync(CONFIG_PATH, dump(raw), 'utf8')

export const setMode = (mode: PermissionMode): void => saveRaw(applyMode(loadRaw(), mode))
export const setOverride = (kind: 'tool' | 'plugin', name: string, perm: Permission): void =>
  saveRaw(applyOverride(loadRaw(), kind, name, perm))
export const addAllowedCommand = (signature: string): void =>
  saveRaw(applyAllowedCommand(loadRaw(), signature))
