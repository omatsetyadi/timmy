/** Navigate input history. `index` is null when on a fresh line. `history` is oldest→newest.
 *  up → older (toward 0); down → newer, past the newest returns to a fresh empty line. */
export function historyNav(
  history: string[],
  index: number | null,
  key: 'up' | 'down',
): { index: number | null; value: string } {
  if (history.length === 0) return { index: null, value: '' }
  if (key === 'up') {
    const next = index === null ? history.length - 1 : Math.max(0, index - 1)
    return { index: next, value: history[next] }
  }
  if (index === null) return { index: null, value: '' }
  const next = index + 1
  if (next >= history.length) return { index: null, value: '' }
  return { index: next, value: history[next] }
}
