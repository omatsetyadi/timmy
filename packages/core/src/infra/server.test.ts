import { Effect, Layer, ManagedRuntime } from 'effect'
import type { FastifyInstance } from 'fastify'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, type TimmyConfig } from '../domain/config/config'
import { PendingConfirmations } from '../domain/tools/confirmations'
import { PermissionOverlay } from '../domain/tools/permission-overlay'
import { buildServer } from './server'

// The /confirm "always" branch writes through to config.yaml via permission-cli. Stub those side
// effects (vi.mock is hoisted above the buildServer import) so the test never touches the real
// ~/.timmy/config.yaml; assert on the calls instead.
const addAllowedCommand = vi.fn()
const setOverride = vi.fn()
const setMode = vi.fn()
vi.mock('./permission-cli', () => ({
  addAllowedCommand: (sig: string) => addAllowedCommand(sig),
  setOverride: (kind: 'tool' | 'plugin', name: string, perm: string) =>
    setOverride(kind, name, perm),
  setMode: (mode: string) => setMode(mode),
}))

// Auth disabled so /confirm is reachable without a bearer token. The route only resolves
// PendingConfirmations + PermissionOverlay, so a runtime with just those two is sufficient
// (cast to the full AppServices the buildServer signature expects).
const TEST_CONFIG = {
  server: { host: '127.0.0.1', port: 0, auth: { enabled: false, token: 'keychain' } },
} as unknown as TimmyConfig

type ConfirmServices = PendingConfirmations | PermissionOverlay
type AlwaysPayload = { scope: 'command'; signature: string } | { scope: 'tool'; tool: string }

describe('POST /confirm/:id', () => {
  let app: FastifyInstance
  let runtime: ManagedRuntime.ManagedRuntime<ConfirmServices, never>

  beforeEach(async () => {
    addAllowedCommand.mockClear()
    setOverride.mockClear()
    runtime = ManagedRuntime.make(Layer.merge(PendingConfirmations.Live, PermissionOverlay.Live))
    app = await buildServer(TEST_CONFIG, runtime as never)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    await runtime.dispose()
  })

  const overlay = () => runtime.runPromise(PermissionOverlay.pipe(Effect.flatMap((o) => o.get)))
  const createPending = (id: string, always: AlwaysPayload) =>
    runtime.runPromise(PendingConfirmations.pipe(Effect.flatMap((p) => p.create(id, always))))

  it("decision:'always' (command) resolves, adds it to the live overlay + persists", async () => {
    await createPending('c1', { scope: 'command', signature: 'git commit' })
    const res = await app.inject({
      method: 'POST',
      url: '/confirm/c1',
      payload: { decision: 'always' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ resolved: true })
    expect((await overlay()).commands).toContain('git commit')
    expect(addAllowedCommand).toHaveBeenCalledWith('git commit')
  })

  it("decision:'always' (tool) sets the override on the live overlay + persists", async () => {
    await createPending('c2', { scope: 'tool', tool: 'runAppleScript' })
    const res = await app.inject({
      method: 'POST',
      url: '/confirm/c2',
      payload: { decision: 'always' },
    })
    expect(res.statusCode).toBe(200)
    expect((await overlay()).tools).toMatchObject({ runAppleScript: 'allow' })
    expect(setOverride).toHaveBeenCalledWith('tool', 'runAppleScript', 'allow')
  })

  it("decision:'once' resolves true but does NOT touch the overlay", async () => {
    await createPending('c3', { scope: 'command', signature: 'ls' })
    const res = await app.inject({
      method: 'POST',
      url: '/confirm/c3',
      payload: { decision: 'once' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ resolved: true })
    expect((await overlay()).commands).not.toContain('ls')
    expect(addAllowedCommand).not.toHaveBeenCalled()
    expect(setOverride).not.toHaveBeenCalled()
  })

  it("decision:'deny' resolves the pending entry (200) without touching the overlay", async () => {
    await createPending('c4', { scope: 'command', signature: 'rm' })
    const res = await app.inject({
      method: 'POST',
      url: '/confirm/c4',
      payload: { decision: 'deny' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ resolved: true })
    expect((await overlay()).commands).not.toContain('rm')
    expect(addAllowedCommand).not.toHaveBeenCalled()
  })

  it('returns 404 {resolved:false} for an unknown id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/confirm/nope',
      payload: { decision: 'once' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ resolved: false })
  })

  it('rejects a missing/invalid decision with 400 WITHOUT consuming the pending entry', async () => {
    await createPending('c9', { scope: 'command', signature: 'ls' })
    const bad = await app.inject({ method: 'POST', url: '/confirm/c9', payload: {} })
    expect(bad.statusCode).toBe(400)
    // The pending entry must survive a malformed request — a valid decision still resolves it.
    const ok = await app.inject({
      method: 'POST',
      url: '/confirm/c9',
      payload: { decision: 'once' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ resolved: true })
  })
})

describe('GET/POST /permissions', () => {
  let app: FastifyInstance
  let runtime: ManagedRuntime.ManagedRuntime<
    PendingConfirmations | PermissionOverlay | Config,
    never
  >

  beforeEach(async () => {
    addAllowedCommand.mockClear()
    setOverride.mockClear()
    setMode.mockClear()
    // Boot config posture is controlled via a temp config.yaml so GET is deterministic.
    const dir = mkdtempSync(join(tmpdir(), 'timmy-perms-'))
    const cfgPath = join(dir, 'config.yaml')
    writeFileSync(
      cfgPath,
      'permissions:\n  mode: default\n  commands:\n    allow:\n      - ls\n',
      'utf8',
    )
    runtime = ManagedRuntime.make(
      Layer.mergeAll(PendingConfirmations.Live, PermissionOverlay.Live, Config.Live(cfgPath)),
    )
    app = await buildServer(TEST_CONFIG, runtime as never)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    await runtime.dispose()
  })

  const overlay = () => runtime.runPromise(PermissionOverlay.pipe(Effect.flatMap((o) => o.get)))

  it('GET /permissions returns the effective posture (boot config merged with empty overlay)', async () => {
    const res = await app.inject({ method: 'GET', url: '/permissions' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.mode).toBe('default')
    expect(body.commands).toEqual({ allow: ['ls'] })
  })

  it('GET /permissions reflects live overlay additions', async () => {
    await runtime.runPromise(
      PermissionOverlay.pipe(Effect.flatMap((o) => o.setOverride('webSearch', 'ask'))),
    )
    await runtime.runPromise(
      PermissionOverlay.pipe(Effect.flatMap((o) => o.allowCommand('git commit'))),
    )
    const res = await app.inject({ method: 'GET', url: '/permissions' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tools).toMatchObject({ webSearch: 'ask' })
    expect(body.commands.allow).toEqual(expect.arrayContaining(['ls', 'git commit']))
  })

  it("POST /permissions {mode:'yolo'} sets the overlay mode + persists", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/permissions',
      payload: { mode: 'yolo' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((await overlay()).mode).toBe('yolo')
    expect(setMode).toHaveBeenCalledWith('yolo')
  })

  it('POST /permissions {kind,name,perm} sets the tool override + persists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/permissions',
      payload: { kind: 'tool', name: 'webSearch', perm: 'ask' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((await overlay()).tools).toMatchObject({ webSearch: 'ask' })
    expect(setOverride).toHaveBeenCalledWith('tool', 'webSearch', 'ask')
  })

  it('POST /permissions {allowCommand} adds the command + persists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/permissions',
      payload: { allowCommand: 'git commit' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect((await overlay()).commands).toContain('git commit')
    expect(addAllowedCommand).toHaveBeenCalledWith('git commit')
  })

  it('POST /permissions {} (unknown shape) returns 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/permissions', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(setMode).not.toHaveBeenCalled()
    expect(setOverride).not.toHaveBeenCalled()
    expect(addAllowedCommand).not.toHaveBeenCalled()
  })
})
