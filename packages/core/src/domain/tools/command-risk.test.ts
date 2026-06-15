import { describe, it, expect } from 'vitest'
import { classifyCommand } from './command-risk'

describe('classifyCommand', () => {
  it('allows known read-only commands', () => {
    expect(classifyCommand('ls')).toBe('allow')
    expect(classifyCommand('ls -la /tmp')).toBe('allow')
    expect(classifyCommand('git status')).toBe('allow')
    expect(classifyCommand('docker ps -a')).toBe('allow')
  })

  it('asks on unknown commands (confirm-on-uncertain)', () => {
    expect(classifyCommand('npm install')).toBe('ask')
    expect(classifyCommand('make build')).toBe('ask')
    expect(classifyCommand('./deploy.sh')).toBe('ask')
  })

  it('asks on dangerous commands even when they look like a safe prefix', () => {
    expect(classifyCommand('rm -rf /')).toBe('ask')
    expect(classifyCommand('sudo ls')).toBe('ask')
    expect(classifyCommand('kill 123')).toBe('ask')
    expect(classifyCommand('cat secrets > /etc/passwd')).toBe('ask') // redirection
    expect(classifyCommand('docker system prune -f')).toBe('ask')
    expect(classifyCommand('git push --force')).toBe('ask')
  })

  it('asks on composed commands (chaining/pipe/substitution) — never auto-allowed', () => {
    expect(classifyCommand('ls && rm -rf x')).toBe('ask') // danger anyway
    expect(classifyCommand('ls && weirdcmd')).toBe('ask') // chaining hides an unknown
    expect(classifyCommand('ls | grep foo')).toBe('ask') // pipe
    expect(classifyCommand('echo $(rm x)')).toBe('ask') // substitution
  })

  it('allows a command matching the personal allowlist by prefix', () => {
    expect(classifyCommand('npm install lodash', ['npm install'])).toBe('allow')
    expect(classifyCommand('npm run build', ['npm install'])).toBe('ask') // not the allowed prefix
  })

  it('still asks for a dangerous command even if its prefix was allowlisted', () => {
    expect(classifyCommand('rm -rf /tmp/x', ['rm'])).toBe('ask')
  })

  it('asks before reading credential/secret files even with a safe reader', () => {
    expect(classifyCommand('cat .env')).toBe('ask')
    expect(classifyCommand('cat /Users/me/.ssh/id_rsa')).toBe('ask')
    expect(classifyCommand('ls ~/.aws')).toBe('ask')
    expect(classifyCommand('cat config/.env', ['cat'])).toBe('ask') // not even an allowlist bypasses it
  })

  it('never auto-allows a command carrying shell metacharacters (anti-smuggling)', () => {
    expect(classifyCommand('ls $(whoami)')).toBe('ask') // command substitution
    expect(classifyCommand('ls $HOME')).toBe('ask') // variable expansion
    expect(classifyCommand('echo hi > out.txt')).toBe('ask') // redirection
    expect(classifyCommand('ls `pwd`')).toBe('ask') // backtick
    expect(classifyCommand('git status; rm -rf /', ['git status'])).toBe('ask') // chaining, even allowlisted prefix
  })
})
