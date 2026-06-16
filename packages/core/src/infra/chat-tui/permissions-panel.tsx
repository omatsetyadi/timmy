import React from 'react'
import { Box, Text } from 'ink'
import type { EffectivePermissions } from './client'

export function PermissionsPanel({
  perms,
  selected,
}: {
  perms: EffectivePermissions
  selected: number
}): React.ReactElement {
  const tools = Object.entries(perms.tools ?? {})
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan">permissions — ↑/↓ select · ←/→ cycle allow·ask·block · esc close</Text>
      <Text>mode: {perms.mode} (Shift+Tab toggles)</Text>
      {tools.length === 0 && <Text dimColor>(no tool overrides)</Text>}
      {tools.map(([name, perm], i) => (
        <Text key={name} inverse={i === selected}>{`${name}: ${perm}`}</Text>
      ))}
    </Box>
  )
}
