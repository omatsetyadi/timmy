import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Generic background-process supervision over a pidfile + logfile. Core has no process manager today
 * (`timmy start` is foreground); this is the first one. Kept generic so BOTH core (`timmy start`) and
 * the voice daemon (`timmy voice start`) reuse it — same pidfile/logfile/stop semantics.
 *
 * Pure-ish + dependency-injected (paths passed in) so it's unit-testable without globals.
 */
export interface DaemonPaths {
  /** e.g. ~/.timmy/timmy.pid */
  readonly pidFile: string
  /** e.g. ~/.timmy/timmy.log — child stdout+stderr are appended here */
  readonly logFile: string
}

/** Read + parse the pidfile. `null` if missing or not a positive integer. */
export const readPid = (pidFile: string): number | null => {
  if (!existsSync(pidFile)) return null
  const raw = readFileSync(pidFile, 'utf8').trim()
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** Is a process with this pid alive? `kill(pid, 0)` probes without signalling (EPERM still = alive). */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The live pid if the daemon is running, else `null` — and clears a stale pidfile (dead pid) as a
 *  side effect, so a crashed daemon never blocks the next start. */
export const isRunning = (paths: DaemonPaths): number | null => {
  const pid = readPid(paths.pidFile)
  if (pid === null) return null
  if (isAlive(pid)) return pid
  rmSync(paths.pidFile, { force: true }) // stale — owner died without cleanup
  return null
}

export type StartResult = { started: number } | { alreadyRunning: number }

/**
 * Spawn `command args` as a **detached** background process: stdio redirected to the logfile (append),
 * pid recorded, parent free to exit (`unref`). No-op (returns `alreadyRunning`) if already up.
 */
export const startBackground = (
  paths: DaemonPaths,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): StartResult => {
  const running = isRunning(paths)
  if (running !== null) return { alreadyRunning: running }

  mkdirSync(dirname(paths.pidFile), { recursive: true })
  const log = openSync(paths.logFile, 'a') // append so logs survive restarts
  const child: ChildProcess = spawn(command, [...args], {
    detached: true,
    stdio: ['ignore', log, log],
    env,
  })
  const pid = child.pid
  if (pid === undefined) throw new Error('failed to spawn daemon (no pid)')
  writeFileSync(paths.pidFile, String(pid))
  child.unref() // let the parent CLI process exit without waiting on the child
  return { started: pid }
}

export type StopResult = { stopped: number } | { notRunning: true }

/** Signal the running daemon (default SIGTERM) and remove the pidfile. */
export const stop = (paths: DaemonPaths, signal: NodeJS.Signals = 'SIGTERM'): StopResult => {
  const pid = isRunning(paths)
  if (pid === null) return { notRunning: true }
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone between the check and the kill — treat as stopped */
  }
  rmSync(paths.pidFile, { force: true })
  return { stopped: pid }
}
