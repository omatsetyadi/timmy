import { describe, expect, it } from 'vitest'
import { buildPlist, launchAgentPath, AUTOSTART_LABEL } from './autostart'

describe('buildPlist', () => {
  const plist = buildPlist({
    label: AUTOSTART_LABEL,
    programArgs: ['/Users/me/.local/bin/timmy', 'start', '--foreground'],
    logFile: '/Users/me/.timmy/timmy.log',
  })

  it('is a well-formed plist with the label and a launchd dict', () => {
    expect(plist).toContain('<?xml')
    expect(plist).toContain('<!DOCTYPE plist')
    expect(plist).toContain('<plist version="1.0">')
    expect(plist).toContain(`<key>Label</key>\n  <string>${AUTOSTART_LABEL}</string>`)
  })

  it('lists every program argument as its own <string>, in order', () => {
    const args = plist.slice(plist.indexOf('<array>'), plist.indexOf('</array>'))
    expect(args).toContain('<string>/Users/me/.local/bin/timmy</string>')
    expect(args).toContain('<string>start</string>')
    expect(args).toContain('<string>--foreground</string>')
  })

  it('runs at load, keeps alive, and routes stdout+stderr to the logfile', () => {
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>')
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>')
    expect(plist).toContain(
      '<key>StandardOutPath</key>\n  <string>/Users/me/.timmy/timmy.log</string>',
    )
    expect(plist).toContain(
      '<key>StandardErrorPath</key>\n  <string>/Users/me/.timmy/timmy.log</string>',
    )
  })

  it('XML-escapes special characters in arguments', () => {
    const p = buildPlist({ label: 'x', programArgs: ['a & b <c>'], logFile: '/l' })
    expect(p).toContain('<string>a &amp; b &lt;c&gt;</string>')
  })
})

describe('launchAgentPath', () => {
  it('points at ~/Library/LaunchAgents/<label>.plist', () => {
    expect(launchAgentPath('com.timmy.core')).toMatch(
      /\/Library\/LaunchAgents\/com\.timmy\.core\.plist$/,
    )
  })
})
