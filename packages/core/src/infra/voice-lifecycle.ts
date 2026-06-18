import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '../domain/config/config'
import {
  isRunning,
  startBackground,
  stop,
  type DaemonPaths,
  type StartResult,
  type StopResult,
} from './daemon-supervisor'

/**
 * Lifecycle (install / run / remove) for the `timmy-voice` Python daemon. Voice ships NOT as a binary
 * but as a cloned repo + `uv sync` (heavy Python + ML deps), then run via uv. Process control reuses
 * the generic {@link startBackground}/{@link stop} supervisor — voice is just another supervised daemon.
 * This is core CLI plumbing (the only CLI a user types is `timmy`); the daemon stays a black box reached
 * over the `/stream` contract.
 */
export const VOICE_REPO_URL = 'https://github.com/omatsetyadi/timmy-voice.git'
export const VOICE_DIR = join(CONFIG_DIR, 'voice')
export const VOICE_PATHS: DaemonPaths = {
  pidFile: join(CONFIG_DIR, 'voice.pid'),
  logFile: join(CONFIG_DIR, 'voice.log'),
}
// `--headless` = the hands-free wake-word loop with NO stdin — the right mode for a backgrounded
// daemon (`--voice` is push-to-talk and needs Enter/a terminal, which a detached process doesn't have).
// Reads url/keys/voice.* from the shared ~/.timmy/config.yaml.
const VOICE_RUN = { cmd: 'uv', args: ['run', 'python', '-m', 'timmy_voice', '--headless'] }

/** Installed = the repo is cloned (pyproject.toml present in the canonical dir). */
export const isVoiceInstalled = (dir = VOICE_DIR): boolean =>
  existsSync(join(dir, 'pyproject.toml'))

/** Is a CLI tool present on PATH? (`<tool> --version` exits 0). */
const hasTool = (tool: string): boolean => {
  try {
    execFileSync(tool, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface Preflight {
  python: boolean
  uv: boolean
}
/** What's present for a voice install. `python3` ≥ 3.11 and `uv` are required. */
export const preflight = (): Preflight => ({ python: hasTool('python3'), uv: hasTool('uv') })

export type InstallResult =
  | { ok: true }
  | { ok: false; reason: 'already-installed' | 'missing-python' | 'missing-uv' }

/**
 * Clone timmy-voice → {@link VOICE_DIR} and `uv sync`. Returns a structured reason instead of
 * installing system Python/uv silently (we never auto-install a system toolchain). The CLI surfaces
 * the plan + the fix for each missing prereq.
 */
export const installVoice = (): InstallResult => {
  if (isVoiceInstalled()) return { ok: false, reason: 'already-installed' }
  const pre = preflight()
  if (!pre.python) return { ok: false, reason: 'missing-python' }
  if (!pre.uv) return { ok: false, reason: 'missing-uv' }
  // Clone to a temp dir then MERGE into VOICE_DIR — `git clone` refuses a non-empty target, and
  // VOICE_DIR may already hold pre-install artifacts (an imported wake model under `wakewords/`, the
  // `aec_helper`). Merging keeps those; cpSync overwrites only same-named files (none, in practice).
  const tmp = mkdtempSync(join(tmpdir(), 'timmy-voice-'))
  try {
    execFileSync('git', ['clone', '--depth', '1', VOICE_REPO_URL, tmp], { stdio: 'inherit' })
    mkdirSync(VOICE_DIR, { recursive: true })
    cpSync(tmp, VOICE_DIR, { recursive: true })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  // `--extra voice` pulls the real-audio stack (STT/TTS/wake/AEC/tray); plain `uv sync` installs only
  // the light backbone, leaving the daemon unable to actually listen or speak.
  execFileSync('uv', ['sync', '--extra', 'voice'], { cwd: VOICE_DIR, stdio: 'inherit' })
  return { ok: true }
}

/** Start the voice daemon in the background (no-op if already running; errors if not installed). */
export const startVoice = (): StartResult | { notInstalled: true } => {
  if (!isVoiceInstalled()) return { notInstalled: true }
  return startBackground(VOICE_PATHS, VOICE_RUN.cmd, VOICE_RUN.args, { cwd: VOICE_DIR })
}

export const stopVoice = (): StopResult => stop(VOICE_PATHS)

export interface VoiceLifecycleStatus {
  installed: boolean
  running: number | null
}
export const voiceLifecycleStatus = (): VoiceLifecycleStatus => ({
  installed: isVoiceInstalled(),
  running: isRunning(VOICE_PATHS),
})

/** Stop (if running) and remove the install dir. */
export const uninstallVoice = (): void => {
  stopVoice()
  rmSync(VOICE_DIR, { recursive: true, force: true })
}
