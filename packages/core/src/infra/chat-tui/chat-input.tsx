import React from 'react'
import { Box, Text, useInput } from 'ink'
import {
  type EditorState,
  insertText,
  insertNewline,
  backspace,
  deleteWord,
  deleteToLineStart,
  moveLeft,
  moveRight,
  moveUp,
  moveDown,
} from './editor'

/** A controlled, cursored multi-line input. Maps keystrokes to the pure editor ops and renders
 *  the value with a REAL cursor (an inverse cell) at its row/column. `›` marks the first line;
 *  continuation lines are indented to align under it. Up/Down move the cursor within multi-line
 *  text and only fall through to history (`onHistoryPrev`/`onHistoryNext`) at the top/bottom edge. */
export function ChatInput({
  state,
  onState,
  onSubmit,
  onHistoryPrev,
  onHistoryNext,
}: {
  state: EditorState
  onState: (s: EditorState) => void
  onSubmit: (v: string) => void
  onHistoryPrev: () => void
  onHistoryNext: () => void
}): React.ReactElement {
  useInput((input, key) => {
    if (key.return) {
      if (key.meta || key.shift) onState(insertNewline(state))
      else onSubmit(state.value)
      return
    }
    if (key.leftArrow) {
      onState(moveLeft(state))
      return
    }
    if (key.rightArrow) {
      onState(moveRight(state))
      return
    }
    if (key.upArrow) {
      const n = moveUp(state)
      if (n) onState(n)
      else onHistoryPrev()
      return
    }
    if (key.downArrow) {
      const n = moveDown(state)
      if (n) onState(n)
      else onHistoryNext()
      return
    }
    if (key.backspace || key.delete) {
      onState(key.meta ? deleteWord(state) : backspace(state))
      return
    }
    if (key.ctrl && input === 'w') {
      onState(deleteWord(state))
      return
    }
    if (key.ctrl && input === 'u') {
      onState(deleteToLineStart(state))
      return
    }
    if (
      input &&
      !key.ctrl &&
      !key.meta &&
      !key.return &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow
    ) {
      onState(insertText(state, input))
    }
  })

  const lines = state.value === '' ? [''] : state.value.split('\n')
  // The cursor's row + column within those lines.
  const before = state.value.slice(0, state.cursor)
  const cursorRow = before.split('\n').length - 1
  const nl = before.lastIndexOf('\n')
  const cursorCol = nl === -1 ? state.cursor : state.cursor - (nl + 1)

  return (
    <Box flexDirection="column">
      {lines.map((ln, i) => (
        <Text key={i}>
          <Text color="blue">{i === 0 ? '› ' : '  '}</Text>
          {i === cursorRow ? <CursorLine line={ln} col={cursorCol} /> : ln}
        </Text>
      ))}
    </Box>
  )
}

/** Renders a single line with the char at `col` shown inverse (the cursor). When the cursor sits
 *  at end-of-line, a trailing inverse space is rendered so the cursor is still visible. */
function CursorLine({ line, col }: { line: string; col: number }): React.ReactElement {
  const head = line.slice(0, col)
  const at = line.slice(col, col + 1)
  const tail = line.slice(col + 1)
  return (
    <Text>
      {head}
      <Text inverse>{at === '' ? ' ' : at}</Text>
      {tail}
    </Text>
  )
}
