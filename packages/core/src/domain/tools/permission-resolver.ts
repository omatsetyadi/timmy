import type { RiskClassifierContext, RiskDecision, RiskLevel } from 'timmy-sdk'
import { Permission, type PermissionConfig } from '../config/config'
import { classifyCommand, RUN_COMMAND } from './command-risk'

export interface ResolveInput {
  toolName: string
  riskLevel: RiskLevel
  args: Record<string, unknown>
  /** Owning plugin name (undefined for core tools). */
  plugin?: string
  config: PermissionConfig
  /** The tool's optional dynamic classifier (SDK `Tool.classify`). When present, it decides the
   *  per-call risk instead of the static `riskLevel` — the path that lets gated tools be plugins. */
  classify?: (args: Record<string, unknown>, ctx: RiskClassifierContext) => RiskDecision
}

/** Is this tool switched off entirely? — a tool/plugin override of `block`, or the tool
 *  declaring `riskLevel: 'blocked'`. Used both as the resolver's safety floor and by the
 *  registry to hide blocked tools from the model. Not even YOLO overrides this. */
export function isBlocked(
  toolName: string,
  riskLevel: RiskLevel,
  plugin: string | undefined,
  config: PermissionConfig,
): boolean {
  return (
    config.tools?.[toolName] === Permission.BLOCK ||
    (plugin !== undefined && config.plugins?.[plugin] === Permission.BLOCK) ||
    riskLevel === 'blocked'
  )
}

/** Resolve one tool call to `allow | ask | block`, in precedence order:
 *  1. blocked (tool/plugin override = block, or the tool declares `blocked`) — wins even under YOLO
 *  2. explicit allow/ask override (tool beats plugin)
 *  3. YOLO mode → allow
 *  4. the tool's own decision: runCommand's built-in classifier, else the tool's `classify`
 *     hook (the plugin path), else the declared tier. */
export function resolvePermission(input: ResolveInput): Permission {
  const { toolName, riskLevel, args, plugin, config, classify } = input
  const toolOverride = config.tools?.[toolName]
  const pluginOverride = plugin ? config.plugins?.[plugin] : undefined

  // 1. block (the off-switch / safety floor) — not even YOLO overrides it.
  if (isBlocked(toolName, riskLevel, plugin, config)) return Permission.BLOCK

  // 2. explicit allow/ask override — most specific wins.
  if (toolOverride === Permission.ALLOW || toolOverride === Permission.ASK) return toolOverride
  if (pluginOverride === Permission.ALLOW || pluginOverride === Permission.ASK)
    return pluginOverride

  // 3. YOLO bypasses asking.
  if (config.mode === 'yolo') return Permission.ALLOW

  // 4. the tool's own decision.
  // runCommand keeps its built-in classifier (core-special until it migrates to a plugin in the
  // libs+plugins realignment; at that point it declares `classify` like any other plugin tool).
  if (toolName === RUN_COMMAND)
    return classifyCommand(String(args.command ?? ''), config.commands?.allow ?? [])
  // Any tool can supply a dynamic classifier (the generalized plugin path, e.g. runAppleScript).
  if (classify)
    return classify(args, { allowlist: config.commands?.allow ?? [] }) === 'allow'
      ? Permission.ALLOW
      : Permission.ASK
  return riskLevel === 'safe' ? Permission.ALLOW : Permission.ASK
}
