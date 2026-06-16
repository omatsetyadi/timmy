import React from 'react'
import { Box, Text } from 'ink'
import type { ConfirmReq } from './reduce'

export function ConfirmPanel({ req }: { req: ConfirmReq }): React.ReactElement {
  const alwaysText =
    req.always.scope === 'command'
      ? `[a] always allow \`${req.always.label}\``
      : `[a] always allow ${req.always.label}`
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">⚠ {req.tool} wants to run:</Text>
      {req.description.split('\n').map((line, i) => (
        <Text key={i} dimColor>{`  ${line}`}</Text>
      ))}
      <Text>
        <Text color="green">[y]es</Text> <Text color="red">[n]o</Text>{' '}
        <Text color="cyan">{alwaysText}</Text>
      </Text>
    </Box>
  )
}
