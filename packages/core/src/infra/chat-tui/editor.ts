/** A cursored text buffer: `value` may contain '\n', and `cursor` is an index 0..value.length
 *  into it. These are the pure ops the multi-line input maps keys onto. */
export interface EditorState {
  value: string
  cursor: number
}

export const emptyEditor = (): EditorState => ({ value: '', cursor: 0 })

export const fromValue = (value: string): EditorState => ({ value, cursor: value.length })

export const insertText = (s: EditorState, t: string): EditorState => ({
  value: s.value.slice(0, s.cursor) + t + s.value.slice(s.cursor),
  cursor: s.cursor + t.length,
})

export const insertNewline = (s: EditorState): EditorState => insertText(s, '\n')

export const backspace = (s: EditorState): EditorState =>
  s.cursor === 0
    ? s
    : { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 }

export const moveLeft = (s: EditorState): EditorState => ({
  ...s,
  cursor: Math.max(0, s.cursor - 1),
})

export const moveRight = (s: EditorState): EditorState => ({
  ...s,
  cursor: Math.min(s.value.length, s.cursor + 1),
})

/** Delete from the cursor back to the previous word boundary (trailing spaces then a run of
 *  non-space); text AFTER the cursor is preserved. */
export function deleteWord(s: EditorState): EditorState {
  const before = s.value.slice(0, s.cursor)
  const trimmed = before.replace(/\s+$/, '').replace(/\S+$/, '')
  return { value: trimmed + s.value.slice(s.cursor), cursor: trimmed.length }
}

/** Delete from the cursor back to the start of the current line (after the previous '\n');
 *  text AFTER the cursor is preserved. */
export function deleteToLineStart(s: EditorState): EditorState {
  const before = s.value.slice(0, s.cursor)
  const nl = before.lastIndexOf('\n')
  const keep = nl === -1 ? '' : before.slice(0, nl + 1)
  return { value: keep + s.value.slice(s.cursor), cursor: keep.length }
}

/** The cursor's line index + column (chars since the last '\n' before the cursor). */
function lineColumn(s: EditorState): { lines: string[]; line: number; column: number } {
  const lines = s.value.split('\n')
  const before = s.value.slice(0, s.cursor)
  const nl = before.lastIndexOf('\n')
  const line = before.split('\n').length - 1
  const column = nl === -1 ? s.cursor : s.cursor - (nl + 1)
  return { lines, line, column }
}

/** Offset of the first char of line `idx` (sum of prior line lengths each +1 for its '\n'). */
function lineStart(lines: string[], idx: number): number {
  let offset = 0
  for (let i = 0; i < idx; i++) offset += lines[i].length + 1
  return offset
}

/** Move to the same column on the previous line. Returns null on the first line so the caller
 *  can fall through to history. */
export function moveUp(s: EditorState): EditorState | null {
  const { lines, line, column } = lineColumn(s)
  if (line === 0) return null
  const target = lines[line - 1]
  const newColumn = Math.min(column, target.length)
  return { ...s, cursor: lineStart(lines, line - 1) + newColumn }
}

/** Move to the same column on the next line. Returns null on the last line so the caller can
 *  fall through to history. */
export function moveDown(s: EditorState): EditorState | null {
  const { lines, line, column } = lineColumn(s)
  if (line === lines.length - 1) return null
  const target = lines[line + 1]
  const newColumn = Math.min(column, target.length)
  return { ...s, cursor: lineStart(lines, line + 1) + newColumn }
}
