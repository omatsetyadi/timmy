import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
const VOICE_RUN_ARGS = ['run', 'python', '-m', 'timmy_voice', '--headless']

/** Installed = the repo is cloned (pyproject.toml present in the canonical dir). */
export const isVoiceInstalled = (dir = VOICE_DIR): boolean =>
  existsSync(join(dir, 'pyproject.toml'))

/** Resolve a working `uv` — on PATH, or where its installer drops it (`~/.local/bin`, `~/.cargo/bin`).
 *  Returns the command to invoke, or null if uv isn't available. (A freshly-installed uv isn't on the
 *  current process's PATH, so we probe the known install locations too.) */
const findUv = (): string | null => {
  for (const cmd of [
    'uv',
    join(homedir(), '.local', 'bin', 'uv'),
    join(homedir(), '.cargo', 'bin', 'uv'),
  ]) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' })
      return cmd
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** Install uv via its official one-line installer. uv then manages its OWN isolated Python, so the
 *  user needs no preinstalled Python — `uv sync` downloads a managed interpreter on demand. */
const installUv = (): void => {
  execFileSync('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], {
    stdio: 'inherit',
  })
}

export interface Preflight {
  uv: boolean
}
/** Whether `uv` is already present. (No Python check — `uv` provisions an isolated Python itself.) */
export const preflight = (): Preflight => ({ uv: findUv() !== null })

export type InstallResult =
  | { ok: true }
  | { ok: false; reason: 'already-installed' | 'uv-unavailable' }

/**
 * Install the voice daemon, self-sufficiently: bootstrap `uv` if missing (its official installer), then
 * clone timmy-voice → {@link VOICE_DIR} and `uv sync --extra voice`. **No preinstalled Python/uv
 * required** — uv installs + isolates its own Python (`uv sync` auto-downloads a managed ≥3.11 per the
 * project's `requires-python`), and the deps live in an isolated venv. The closest equivalent to core's
 * single binary for a Python daemon.
 */
export const installVoice = (): InstallResult => {
  if (isVoiceInstalled()) return { ok: false, reason: 'already-installed' }
  let uv = findUv()
  if (!uv) {
    console.log('  uv not found — installing it (astral.sh official installer)…')
    try {
      installUv()
    } catch {
      /* fall through — re-probe below */
    }
    uv = findUv()
  }
  if (!uv) return { ok: false, reason: 'uv-unavailable' }
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
  // `--extra voice` pulls the real-audio stack (STT/TTS/wake/AEC/tray) + provisions an isolated Python;
  // plain `uv sync` installs only the light backbone, leaving the daemon unable to listen or speak.
  execFileSync(uv, ['sync', '--extra', 'voice'], { cwd: VOICE_DIR, stdio: 'inherit' })
  return { ok: true }
}

/** Start the voice daemon in the background (no-op if already running; errors if not installed). */
export const startVoice = (): StartResult | { notInstalled: true } => {
  if (!isVoiceInstalled()) return { notInstalled: true }
  // Resolve uv (it may be off-PATH right after install); fall back to bare `uv` for a normal shell.
  return startBackground(VOICE_PATHS, findUv() ?? 'uv', VOICE_RUN_ARGS, { cwd: VOICE_DIR })
}

export type UpdateResult =
  | { ok: true; restarted: boolean }
  | { ok: false; reason: 'not-installed' | 'uv-unavailable' }

/**
 * Pull the latest timmy-voice and re-sync deps. The install dir is a MANAGED checkout (not a user
 * workspace), so we hard-reset to `origin/main` — fixing the "voice still runs the old code after I
 * pushed" gap, where a plain re-install left the local clone a commit behind. Re-syncs the venv and
 * restarts the daemon if it was running.
 */
export const updateVoice = (): UpdateResult => {
  if (!isVoiceInstalled()) return { ok: false, reason: 'not-installed' }
  const uv = findUv()
  if (!uv) return { ok: false, reason: 'uv-unavailable' }
  const wasRunning = isRunning(VOICE_PATHS) !== null
  execFileSync('git', ['-C', VOICE_DIR, 'fetch', '--depth', '1', 'origin', 'main'], {
    stdio: 'inherit',
  })
  execFileSync('git', ['-C', VOICE_DIR, 'reset', '--hard', 'origin/main'], { stdio: 'inherit' })
  execFileSync(uv, ['sync', '--extra', 'voice'], { cwd: VOICE_DIR, stdio: 'inherit' })
  if (wasRunning) {
    stopVoice()
    startVoice()
  }
  return { ok: true, restarted: wasRunning }
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
