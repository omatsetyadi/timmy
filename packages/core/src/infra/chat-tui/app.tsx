import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput } from 'ink'
import { readConfigSync } from '../../domain/config/config'
import { ChatInput } from './chat-input'
import { emptyEditor, fromValue } from './editor'
import { Transcript, Parts } from './transcript'
import { ConfirmPanel } from './confirm-panel'
import { PermissionsPanel } from './permissions-panel'
import { initialState, reduceFrame, withUserMessage, type ChatState } from './reduce'
import { filterCommands, parseSlash } from './slash'
import { historyNav } from './history'
import {
  resolveDaemon,
  streamChat,
  sendConfirm,
  getPermissions,
  postPermissions,
  type Daemon,
  type EffectivePermissions,
} from './client'

const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('')

/** The welcome header, printed ONCE to stdout before the Ink app renders — so it lands at the top
 *  of the session's scrollback (like Claude Code's banner) and scrolls away as you chat, rather
 *  than reprinting in the live region above the input. A closed cyan box. */
export function banner(model?: string): string {
  const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`
  const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`
  const l1 = `✻ Timmy${model ? `   ·   ${model}` : ''}   ·   /exit to quit`
  const l2 = 'Talk to your machine. Type / for commands.'
  const w = Math.max(l1.length, l2.length) + 2
  const pad = (s: string): string => ` ${s}${' '.repeat(w - s.length - 1)}`
  return [
    cyan(`╭${'─'.repeat(w)}╮`),
    `${cyan('│')}${cyan(pad(l1))}${cyan('│')}`,
    `${cyan('│')}${dim(pad(l2))}${cyan('│')}`,
    cyan(`╰${'─'.repeat(w)}╯`),
  ].join('\n')
}

export function App({
  daemon,
  initialThread,
}: {
  daemon: Daemon
  initialThread?: string
}): React.ReactElement {
  const { exit } = useApp()
  const [state, setState] = useState<ChatState>(() => ({
    ...initialState(),
    threadId: initialThread,
  }))
  const [editor, setEditor] = useState(emptyEditor())
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const [mode, setMode] = useState<'default' | 'yolo'>('default')
  const [thinking, setThinking] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [histIndex, setHistIndex] = useState<number | null>(null)
  const [perms, setPerms] = useState<EffectivePermissions | null>(null)
  const [permSel, setPermSel] = useState(0)
  const [busy, setBusy] = useState(false)
  // The in-flight turn's AbortController — Esc aborts it (closes the request → server interrupts).
  const abortRef = useRef<AbortController | null>(null)

  // Spinner animates the WHOLE time a turn is in flight (thinking, calling tools, iterating),
  // not just before the first token — so tool-execution pauses don't look frozen.
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(id)
  }, [busy])

  const slash = parseSlash(editor.value)
  const showMenu = slash.isSlash && !busy && !state.confirm && !perms
  const menu = showMenu ? filterCommands(slash.query) : []

  useInput((inputChar, key) => {
    if (key.shift && key.tab) {
      const next = mode === 'default' ? 'yolo' : 'default'
      setMode(next)
      void postPermissions(daemon, { mode: next })
      return
    }
    if (state.confirm) {
      const dec = key.escape
        ? 'deny'
        : inputChar === 'y'
          ? 'once'
          : inputChar === 'a'
            ? 'always'
            : inputChar === 'n'
              ? 'deny'
              : null
      if (dec) {
        void sendConfirm(daemon, state.confirm.id, dec)
        setState((s) => ({ ...s, confirm: undefined }))
      }
      return
    }
    // Esc while a turn is running → abort it (no confirm/panel open).
    if (busy && key.escape) {
      abortRef.current?.abort()
      return
    }
    if (perms) {
      const tools = Object.entries(perms.tools ?? {})
      if (key.escape) {
        setPerms(null)
        return
      }
      if (key.upArrow) setPermSel((i) => Math.max(0, i - 1))
      if (key.downArrow) setPermSel((i) => Math.min(tools.length - 1, i + 1))
      if ((key.leftArrow || key.rightArrow) && tools[permSel]) {
        const order = ['allow', 'ask', 'block'] as const
        const [name, cur] = tools[permSel]
        const nextPerm =
          order[(order.indexOf(cur as (typeof order)[number]) + (key.rightArrow ? 1 : 2)) % 3]
        void postPermissions(daemon, { kind: 'tool', name, perm: nextPerm })
        setPerms({ ...perms, tools: { ...perms.tools, [name]: nextPerm } })
      }
      return
    }
  })

  // Arrows live in ChatInput now; it only delegates to these at the top/bottom text edge.
  const onHistoryPrev = (): void => {
    const { index, value } = historyNav(history, histIndex, 'up')
    setHistIndex(index)
    setEditor(fromValue(value))
  }
  const onHistoryNext = (): void => {
    const { index, value } = historyNav(history, histIndex, 'down')
    setHistIndex(index)
    setEditor(fromValue(value))
  }

  const submit = async (value: string): Promise<void> => {
    if (busy) return // a turn is in flight — don't start a second concurrent stream (avoids interleaved output)
    const text = value.trim()
    setEditor(emptyEditor())
    if (text === '') return
    if (parseSlash(text).isSlash) {
      const name = parseSlash(text).query.split(/\s+/)[0]
      if (name === 'exit' || name === 'quit') return exit()
      if (name === 'think') {
        setThinking((t) => !t)
        return
      }
      if (name === 'permissions') {
        setPerms(await getPermissions(daemon))
        setPermSel(0)
        return
      }
      if (name === 'help') {
        setState((s) => ({
          ...s,
          transcript: [
            ...s.transcript,
            {
              role: 'assistant',
              parts: [{ type: 'text', text: '/think /permissions /help /exit' }],
            },
          ],
        }))
        return
      }
      return
    }
    setHistory((h) => [...h, text])
    setHistIndex(null)
    setState((s) => withUserMessage(s, text))
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      for await (const frame of streamChat(daemon, text, state.threadId, controller.signal)) {
        setState((s) => reduceFrame(s, frame))
      }
    } catch (e) {
      // On abort, commit the partial turn with an "interrupted" note; on a real error, the error.
      const note = controller.signal.aborted
        ? '⏹ interrupted'
        : `✗ ${e instanceof Error ? e.message : String(e)}`
      setState((s) => ({
        ...s,
        transcript: [
          ...s.transcript,
          { role: 'assistant', parts: [...s.parts, { type: 'text', text: `  ${note}` }] },
        ],
        parts: [],
      }))
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  return (
    <Box flexDirection="column">
      <Transcript items={state.transcript} />
      {state.parts.length > 0 && (
        <Box flexDirection="column">
          <Text color="green">timmy ›</Text>
          <Parts parts={state.parts} />
        </Box>
      )}
      {busy &&
        (() => {
          // Transient bottom indicator: a single spinner line for the CURRENT activity (last tool
          // name if the last part is a tool, else "thinking"). Disappears when the turn finishes.
          const last = state.parts[state.parts.length - 1]
          const activity =
            last && last.type === 'tool' ? last.name : thinking ? 'thinking hard' : 'thinking'
          return <Text color="yellow">{`  ${SPINNER_FRAMES[spinnerFrame]} ${activity}…`}</Text>
        })()}
      {state.confirm && <ConfirmPanel req={state.confirm} />}
      {perms && <PermissionsPanel perms={perms} selected={permSel} />}
      {showMenu && (
        <Box flexDirection="column">
          {menu.map((c) => (
            <Text key={c.name} color="cyan">{`  /${c.name} — ${c.summary}`}</Text>
          ))}
        </Box>
      )}
      {!state.confirm && !perms && (
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <ChatInput
            state={editor}
            onState={setEditor}
            onSubmit={submit}
            onHistoryPrev={onHistoryPrev}
            onHistoryNext={onHistoryNext}
          />
        </Box>
      )}
      <Text dimColor>
        {busy
          ? '  working… · Esc to interrupt · Ctrl+C to quit'
          : `  [${mode}] · shift+tab mode · / cmds · ⏎ send · ⌥⏎ newline`}
      </Text>
    </Box>
  )
}

/** The entry the CJS cli dynamically imports (`await import('./chat-tui/app.mjs')`). Preflights the
 *  daemon, then renders the Ink app and waits until the user exits. */
export async function runChat(opts: { threadArg?: string } = {}): Promise<void> {
  const config = readConfigSync()
  const daemon = await resolveDaemon(config)
  try {
    await fetch(`${daemon.base}/health`)
  } catch {
    console.error("Timmy isn't running — start it with `timmy start`.")
    process.exit(1)
  }
  // Print the welcome banner ONCE (stays in scrollback above the live Ink region).
  process.stdout.write(banner(config.models.frontdesk.model) + '\n\n')
  const { waitUntilExit } = render(<App daemon={daemon} initialThread={opts.threadArg} />)
  await waitUntilExit()
}
