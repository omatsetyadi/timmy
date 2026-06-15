import { Context, Effect, Layer } from 'effect'
import { Platform, type Tool, type ToolContext, type ToolResult } from 'timmy-sdk'
import { CredentialStore } from '../credentials/credential-store'
import { ToolError, ToolNotFoundError } from './errors'
import { ToolSource } from './tool-source'

/** Node's `process.platform` → the SDK's `Platform`, so tools can branch on the OS without
 *  depending on any machine package. Unknown unix-likes (freebsd, etc.) fall back to
 *  `Platform.LINUX` rather than throwing — `platform` is an informational tag, never a reason
 *  to fail tool registration. Computed once at registry build. */
const PLATFORM_BY_NODE: Partial<Record<NodeJS.Platform, Platform>> = {
  win32: Platform.WINDOWS,
  darwin: Platform.MAC,
  linux: Platform.LINUX,
}
const currentPlatform = (): Platform => PLATFORM_BY_NODE[process.platform] ?? Platform.LINUX

export interface ModelTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export class ToolRegistry extends Context.Tag('timmy/tools/registry')<
  ToolRegistry,
  {
    readonly list: () => readonly Tool[]
    readonly toModelTools: () => ModelTool[]
    readonly execute: (
      name: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<ToolResult, ToolError | ToolNotFoundError>
  }
>() {
  static Live = Layer.effect(
    ToolRegistry,
    Effect.gen(function* () {
      const { tools, credentialScopeByTool } = yield* ToolSource
      const credStore = yield* CredentialStore
      const platform = currentPlatform()

      // Register each tool alongside a credentials object scoped to its owning plugin's
      // declared keys. Built once at registration time: the scope is static per tool, so
      // there's no reason to rebuild it on every execute.
      const byName = new Map<string, { tool: Tool; credentials: ToolContext['credentials'] }>()
      for (const tool of tools) {
        if (byName.has(tool.name)) {
          yield* Effect.logWarning(`duplicate tool '${tool.name}' ignored`)
          continue
        }
        const scope = credentialScopeByTool.get(tool.name)
        const allowed = new Set(scope?.keys ?? [])
        // Least-privilege: resolve only keys the owning plugin declared, under the
        // keychain convention `<pluginName>:<key>`. Undeclared keys (and tools with no
        // owning plugin, e.g. bare 3a tool lists) never reach the store → always null.
        // Plugin names are validated colon-free (plugin-schema.ts) so a plugin can't
        // forge another plugin's credential namespace via the `<pluginName>:<key>` prefix.
        const credentials: ToolContext['credentials'] = {
          get: (key: string): Promise<string | null> =>
            scope && allowed.has(key)
              ? Effect.runPromise(credStore.get(`${scope.plugin}:${key}`))
              : Promise.resolve(null),
        }
        byName.set(tool.name, { tool, credentials })
      }

      return {
        list: () => [...byName.values()].map((e) => e.tool),
        toModelTools: () =>
          [...byName.values()].map(({ tool }) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        execute: (name, args) =>
          Effect.gen(function* () {
            const entry = byName.get(name)
            if (!entry)
              return yield* Effect.fail(
                new ToolNotFoundError({ message: `unknown tool: ${name}`, tool: name }),
              )
            const { tool, credentials } = entry
            // tryPromise provides an AbortSignal that fires on interruption, so an
            // interrupted turn cancels in-flight tool work. (SafeExecution gating is
            // applied by the caller before this runs.)
            return yield* Effect.tryPromise({
              try: (abortSignal) =>
                tool.execute(args, { credentials, signal: abortSignal, platform }),
              catch: (e) =>
                new ToolError({ message: `tool '${name}' failed`, tool: name, cause: e }),
            })
          }),
      }
    }),
  )
}
