import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isAlive, isRunning, readPid, startBackground, stop } from './daemon-supervisor'

let dir: string
const paths = () => ({ pidFile: join(dir, 'p.pid'), logFile: join(dir, 'p.log') })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-sup-'))
})
afterEach(() => {
  // best-effort: stop any process this test started, then remove the temp dir
  try {
    stop(paths())
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('readPid', () => {
  it('parses a numeric pidfile, returns null for missing or garbage', () => {
    expect(readPid(join(dir, 'nope.pid'))).toBeNull()
    writeFileSync(join(dir, 'g.pid'), 'not-a-number')
    expect(readPid(join(dir, 'g.pid'))).toBeNull()
    writeFileSync(join(dir, 'ok.pid'), '12345\n')
    expect(readPid(join(dir, 'ok.pid'))).toBe(12345)
  })
})

describe('isAlive', () => {
  it('true for this process, false for an unused pid', () => {
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(2 ** 30)).toBe(false) // no process at this pid
  })
})

describe('isRunning', () => {
  it('returns null and clears a stale pidfile (pid no longer alive)', () => {
    writeFileSync(paths().pidFile, String(2 ** 30))
    expect(isRunning(paths())).toBeNull()
    expect(readPid(paths().pidFile)).toBeNull() // stale file removed
  })
})

describe('startBackground + stop (real detached child)', () => {
  // A trivial long-lived child: node sleeping. Proves spawn-detached + pidfile + stop(SIGTERM).
  const sleeper = [process.execPath, '-e', 'setInterval(() => {}, 1e9)']

  it('starts a detached child, records the pid, then stops it', () => {
    const r = startBackground(paths(), sleeper[0], sleeper.slice(1))
    expect('started' in r && r.started).toBeTruthy()
    const pid = isRunning(paths())
    expect(pid).not.toBeNull()
    expect(isAlive(pid!)).toBe(true)

    const s = stop(paths())
    expect('stopped' in s).toBe(true)
    expect(readPid(paths().pidFile)).toBeNull() // pidfile cleaned up
  })

  it('does not start a second instance when one is already running', () => {
    startBackground(paths(), sleeper[0], sleeper.slice(1))
    const again = startBackground(paths(), sleeper[0], sleeper.slice(1))
    expect('alreadyRunning' in again).toBe(true)
  })

  it('stop reports notRunning when nothing is started', () => {
    expect(stop(paths())).toEqual({ notRunning: true })
  })

  it('appends child output to the logfile', async () => {
    startBackground(paths(), process.execPath, ['-e', "console.log('hello-from-child')"])
    await new Promise((r) => setTimeout(r, 300)) // let the child write + exit
    expect(readFileSync(paths().logFile, 'utf8')).toContain('hello-from-child')
  })
})
