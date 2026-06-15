import { Permission } from '../config/config'

/** The core terminal tool's name — the one tool whose permission is decided per-command by
 *  {@link classifyCommand} rather than a static risk tier. */
export const RUN_COMMAND = 'runCommand'

/** Honest shell-command classification for the `runCommand` tool. We do NOT try to prove an
 *  arbitrary command safe — that's not solvable. Instead: a curated read-only set (and the
 *  user's grown allowlist) auto-runs; a curated dangerous set always asks; composed commands
 *  (chaining/pipe/substitution) always ask (they can hide anything); everything else asks.
 *  Returns only `allow` | `ask` (never `block`). */

/** Read-only programs/subcommands that are safe to auto-run. Matched as a whole-token prefix. */
const SAFE_PREFIXES: readonly string[] = [
  'ls',
  'pwd',
  'cat',
  'echo',
  'ps',
  'df',
  'du',
  'whoami',
  'env',
  'which',
  'date',
  'uname',
  'head',
  'tail',
  'wc',
  'git status',
  'git log',
  'git diff',
  'git branch',
  'docker ps',
  'docker images',
  'docker logs',
]

/** Always-ask patterns — destructive/privileged operations, plus reads of credential/secret
 *  files (so even a "safe" reader like `cat`/`ls` asks before exposing a key to the model).
 *  These win even over the allowlist (checked first). */
const DANGER_PATTERNS: readonly RegExp[] = [
  /\brm\b/,
  /\brmdir\b/,
  /\bdd\b/,
  /\bmkfs/,
  /\bkill(all)?\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bsudo\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bgit\s+push\b[^\n]*(?:--force|-f)\b/,
  /\bdocker\s+(?:rm|rmi|system\s+prune)\b/,
  /\bnpm\s+publish\b/,
  /:\s*\(\s*\)\s*\{.*\}\s*;/, // fork-bomb shape
  // credential/secret files — reading them auto would leak into the model's context
  /\.ssh\b/,
  /\bid_rsa\b/,
  /\bid_ed25519\b/,
  /(^|[/\s])\.env\b/,
  /\.aws\b/,
  /\.pem\b/,
  /\.npmrc\b/,
  /\.git-credentials\b/,
]

/** Shell metacharacters that change a command's meaning — chaining (`;` `&` `|`), command
 *  substitution / variable expansion (`` ` `` `$` `()`), grouping/brace expansion (`{}`), and
 *  redirection (`<` `>`). A command containing ANY of these is NEVER auto-allowed: it goes to
 *  `ask` so a human reviews it. This is the auto-allow security boundary — it stops shell
 *  metacharacters being smuggled through the arguments of an otherwise safe-looking command,
 *  and means `shell:true` execution only ever auto-runs plain `program args` strings. */
const SHELL_METACHARS = /[;&|`$(){}<>]/

const startsWithToken = (cmd: string, prefix: string): boolean =>
  cmd === prefix || cmd.startsWith(prefix + ' ')

export function classifyCommand(command: string, allowlist: readonly string[] = []): Permission {
  const norm = command.trim().replace(/\s+/g, ' ')
  // DANGER and metacharacters win over any allowlist (both checked before the allow path).
  if (DANGER_PATTERNS.some((re) => re.test(norm))) return Permission.ASK
  if (SHELL_METACHARS.test(norm)) return Permission.ASK
  const prefixes = [...SAFE_PREFIXES, ...allowlist]
  if (prefixes.some((p) => startsWithToken(norm, p))) return Permission.ALLOW
  return Permission.ASK
}
