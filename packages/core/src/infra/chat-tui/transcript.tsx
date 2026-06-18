import React from 'react'
import { Box, Static, Text } from 'ink'
import { friendlyError, type TranscriptItem, type TurnPart } from './reduce'

export function Parts({ parts }: { parts: TurnPart[] }): React.ReactElement {
  return (
    <>
      {parts.map((p, i) => {
        if (p.type === 'text')
          return (
            <Text key={i} color="white">
              {p.text}
            </Text>
          )
        if (p.type === 'memory')
          return (
            <Text
              key={i}
              color="magenta"
              dimColor
            >{`  ◆ recalled: ${p.entities.join(' · ')}`}</Text>
          )
        if (p.type === 'error')
          return <Text key={i} color="red">{`  ⚠ ${friendlyError(p.message)}`}</Text>
        return <Text key={i} color="cyan">{`  ⏺ ${p.name}`}</Text>
      })}
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
