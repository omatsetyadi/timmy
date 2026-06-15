/** timmy-sdk — the plugin contract. Plugins depend on this; timmy-core validates
 *  against it. Intentionally zero-dependency and Effect-free (decision E). */

/** Plugin contract version. A plugin declares the version it was built against via
 *  `TimmyPlugin.apiVersion`; the host accepts a supported range and skips the rest with
 *  a clear message (it never crashes). Bump only on a breaking contract change. */
export const PLUGIN_API_VERSION = 1

/** Host operating system, surfaced to tools so cross-platform plugins can branch
 *  without depending on any OS package. Exposed as a const object — reference
 *  `Platform.MAC` instead of the bare string — while the value type stays the
 *  `'mac' | 'windows' | 'linux'` union, so plugin authors can still compare
 *  `ctx.platform === 'mac'` ergonomically if they prefer. */
export const Platform = {
  MAC: 'mac',
  WINDOWS: 'windows',
  LINUX: 'linux',
} as const
export type Platform = (typeof Platform)[keyof typeof Platform]

export type RiskLevel = 'safe' | 'confirm' | 'blocked'

export function isRiskLevel(x: unknown): x is RiskLevel {
  return x === 'safe' || x === 'confirm' || x === 'blocked'
}

/** A per-call risk decision from a tool's optional dynamic classifier. Only `allow` | `ask` —
 *  blocking stays a config / `riskLevel` concern, never a classifier's. */
export type RiskDecision = 'allow' | 'ask'

/** Context the host passes to a tool's {@link Tool.classify}. */
export interface RiskClassifierContext {
  /** The user-grown auto-allow entries for this tool (e.g. the terminal tool's safe-command
   *  allowlist). Empty when the user hasn't grown one. */
  readonly allowlist: readonly string[]
}

export interface ToolContext {
  /** Resolves only the credential keys this plugin declared (least-privilege). */
  credentials: { get(key: string): Promise<string | null> }
  /** Aborted when the turn is cancelled. */
  signal: AbortSignal
  /** The host OS this tool is running on. */
  platform: Platform
}

export interface ToolResult {
  ok: boolean
  data?: unknown
  error?: string
}

export interface Tool {
  name: string
  description: string
  /** JSON Schema object describing the args. */
  parameters: Record<string, unknown>
  riskLevel: RiskLevel
  /** Optional per-call risk classification. When present, the host calls it at decision time
   *  with the actual args and uses its result INSTEAD of the static `riskLevel` — e.g. a terminal
   *  tool auto-allows read-only commands but asks on risky ones; an AppleScript tool allows reads
   *  and asks on mutations. Returns `allow` | `ask` only (it can never block — config / `riskLevel`
   *  own blocking). This is what lets gated tools live in plugins, not just core. */
  classify?: (args: Record<string, unknown>, ctx: RiskClassifierContext) => RiskDecision
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export interface CredentialSpec {
  key: string
  label: string
  type: 'secret' | 'oauth' | 'text'
}

export interface TimmyPlugin {
  /** The contract version this plugin targets — set to `PLUGIN_API_VERSION`. */
  apiVersion: number
  name: string
  version: string
  credentials?: CredentialSpec[]
  tools: Tool[]
}
