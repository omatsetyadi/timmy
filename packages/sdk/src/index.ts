/** timmy-sdk — the plugin contract. Plugins depend on this; timmy-core validates
 *  against it. Intentionally zero-dependency and Effect-free (decision E). */

export type RiskLevel = 'safe' | 'confirm' | 'blocked'

export function isRiskLevel(x: unknown): x is RiskLevel {
  return x === 'safe' || x === 'confirm' || x === 'blocked'
}

export interface ToolContext {
  /** Resolves only the credential keys this plugin declared (least-privilege). */
  credentials: { get(key: string): Promise<string | null> }
  /** Aborted when the turn is cancelled. */
  signal: AbortSignal
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
  name: string
  version: string
  credentials?: CredentialSpec[]
  tools: Tool[]
}
