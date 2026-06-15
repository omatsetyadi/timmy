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
