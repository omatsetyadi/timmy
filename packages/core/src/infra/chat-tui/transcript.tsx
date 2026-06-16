import React from 'react'
import { Box, Static, Text } from 'ink'
import type { TranscriptItem, TurnPart } from './reduce'

export function Parts({ parts }: { parts: TurnPart[] }): React.ReactElement {
  return (
    <>
      {parts.map((p, i) =>
        p.type === 'text' ? (
          <Text key={i} color="white">
            {p.text}
          </Text>
        ) : (
          <Text key={i} color="cyan">{`  ⏺ ${p.name}`}</Text>
        ),
      )}
    </>
  )
}

export function Transcript({ items }: { items: TranscriptItem[] }): React.ReactElement {
  return (
    <Static items={items}>
      {(item, i) => (
        <Box key={i} flexDirection="column">
          <Text color={item.role === 'user' ? 'blue' : 'green'}>
            {item.role === 'user' ? 'you ›' : 'timmy ›'}
          </Text>
          <Parts parts={item.parts} />
        </Box>
      )}
    </Static>
  )
}
