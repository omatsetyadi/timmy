export interface SlashCommand {
  name: string
  summary: string
}

/** v1 commands. `/plugins` is v1.1. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'think', summary: 'toggle reasoning display' },
  { name: 'permissions', summary: 'view + toggle tool/plugin permissions' },
  { name: 'help', summary: 'list commands' },
  { name: 'exit', summary: 'quit' },
]

export function parseSlash(input: string): { isSlash: boolean; query: string } {
  return input.startsWith('/')
    ? { isSlash: true, query: input.slice(1) }
    : { isSlash: false, query: '' }
}

export function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase()
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
}
