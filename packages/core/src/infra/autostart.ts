import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Autostart-on-login via a macOS **LaunchAgent** (`~/Library/LaunchAgents/<label>.plist` + launchctl).
 * Generic, but core uses it as `timmy autostart`. Linux (systemd user service) is a future seam — see
 * the lifecycle design; we only implement macOS now (the dev/target machine).
 *
 * Voice does NOT get its own LaunchAgent — there is ONE login item (core); core spawns voice as a
 * child when `voice.autostart` is set (that hook lands with `timmy voice install`, Phase 8B/8C).
 */
export const AUTOSTART_LABEL = 'com.timmy.core'

export interface PlistSpec {
  readonly label: string
  /** Absolute executable + its args, e.g. ['/…/timmy', 'start', '--foreground']. launchd supervises
   *  the long-running process directly, so this is the FOREGROUND server, not the backgrounding wrapper. */
  readonly programArgs: readonly string[]
  readonly logFile: string
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Render a launchd plist (pure — no IO). RunAtLoad + KeepAlive so it starts at login and respawns. */
export const buildPlist = (spec: PlistSpec): string => {
  const args = spec.programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(spec.logFile)}</string>
</dict>
</plist>
`
}

export const launchAgentPath = (label: string): string =>
  join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)

/** Whether the LaunchAgent plist is installed (proxy for "autostart is enabled"). */
export const isAutostartEnabled = (label = AUTOSTART_LABEL): boolean =>
  existsSync(launchAgentPath(label))

/** Write the plist and register it with launchctl (idempotent: unload first if already loaded). */
export const enableAutostart = (spec: PlistSpec): void => {
  const path = launchAgentPath(spec.label)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buildPlist(spec))
  // Best-effort unload then load -w (the classic, widely-compatible launchctl path).
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'ignore' })
  } catch {
    /* not loaded yet — fine */
  }
  execFileSync('launchctl', ['load', '-w', path], { stdio: 'ignore' })
}

/** Unregister and remove the plist. No-op if not present. */
export const disableAutostart = (label = AUTOSTART_LABEL): void => {
  const path = launchAgentPath(label)
  if (!existsSync(path)) return
  try {
    execFileSync('launchctl', ['unload', '-w', path], { stdio: 'ignore' })
  } catch {
    /* already unloaded — fine */
  }
  rmSync(path, { force: true })
}
