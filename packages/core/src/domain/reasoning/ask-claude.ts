import { Effect, Stream } from 'effect'
import type { Tool, ToolResult } from 'timmy-sdk'
import type { StreamChunk } from '../llm/stream-chunk'

export interface AskClaudeDeps {
  available: () => Promise<boolean>
  run: (task: string) => Stream.Stream<StreamChunk, never>
}

const PARAMS = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description: 'a self-contained task for Claude Code to DO (it can run bash/docker/files/git)',
    },
  },
  required: ['task'],
}

export const buildAskClaudeTool = (deps: AskClaudeDeps): Tool => ({
  name: 'askClaude',
  description:
    'Delegate an agentic task to Claude Code, which executes it with its OWN tools (bash, docker, files, git) and reports back. ' +
    'Use for things you cannot do with your own tools — e.g. "spin up a postgres container and create a dev DB", or make a ticket PR-ready. ' +
    'Unlike askModel (which only reasons), Claude Code actually DOES the work.',
  parameters: PARAMS,
  riskLevel: 'confirm', // acts on the machine; overridable via the permission policy (Phase 9)
  execute: async (args, ctx): Promise<ToolResult> => {
    const task = typeof args.task === 'string' ? args.task : ''
    if (!task.trim()) return { ok: false, error: 'askClaude: task is required' }
    if (!(await deps.available()))
      return { ok: false, error: 'askClaude: Claude Code unavailable — run `claude auth status`' }
    const collect = deps.run(task).pipe(
      Stream.runFold(
        { text: '', actions: [] as string[], usage: undefined as unknown },
        (acc, c: StreamChunk) =>
          c.type === 'content'
            ? { ...acc, text: acc.text + c.content }
            : c.type === 'tool_call'
              ? { ...acc, actions: [...acc.actions, c.toolCall.name] }
              : c.type === 'usage'
                ? {
                    ...acc,
                    usage: { promptTokens: c.promptTokens, completionTokens: c.completionTokens },
                  }
                : acc,
      ),
      Effect.map(
        (acc) =>
          ({
            ok: true,
            data: { text: acc.text, actions: acc.actions, usage: acc.usage },
          }) as ToolResult,
      ),
    )
    return Effect.runPromise(collect, { signal: ctx.signal })
  },
})
