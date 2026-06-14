/**
 * timmy-sdk — shared types and plugin interface contracts.
 *
 * Phase 0: placeholder interfaces only. These will be fleshed out as
 * timmy-core gains real capabilities (Phases 1+). Published to npm so that
 * `timmy-plugin-*` repos can depend on the contract.
 */

export type RiskLevel = 'safe' | 'confirm' | 'blocked'

/** A single tool the LLM can call. */
export interface Tool {
  name: string
  description: string
  riskLevel: RiskLevel
  /** JSON-schema-ish parameter map. */
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, ctx: PluginContext) => Promise<unknown>
}

/** Runtime context handed to a plugin's tools and listeners. */
export interface PluginContext {
  credentials: CredentialStore
  emit: (event: string, payload: unknown) => void
}

/** An event listener a plugin can register. */
export interface PluginListener {
  event: string
  handler: (payload: unknown, ctx: PluginContext) => Promise<void> | void
}

/** Credential a plugin declares it needs. */
export interface CredentialSpec {
  key: string
  label: string
  type: 'secret' | 'oauth' | 'text'
}

/** The contract every Timmy plugin implements. */
export interface TimmyPlugin {
  name: string
  version: string
  description: string
  credentials?: CredentialSpec[]
  tools: Tool[]
  listeners?: PluginListener[]
}

/** Secure storage abstraction (backed by the OS keychain in core). */
export interface CredentialStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** Capabilities probed from a model at runtime — never hardcoded in config. */
export interface DetectedCapabilities {
  vision: boolean
  audio: boolean
  tools: boolean
  realtime: boolean
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

/** Uniform interface every model provider implements. */
export interface ModelProvider {
  chat(messages: Message[], tools?: Tool[]): AsyncIterableIterator<string>
  isAvailable(): Promise<boolean>
  detectCapabilities(): Promise<DetectedCapabilities>
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface ProcessInfo {
  pid: number
  name: string
}

/** Cross-platform machine operations (Mac/Windows adapters in core). */
export interface MachineAdapter {
  openApp(name: string): Promise<void>
  playMedia(uri: string): Promise<void>
  getRunningProcesses(): Promise<ProcessInfo[]>
  killProcess(pid: number): Promise<void>
  deleteFile(path: string): Promise<void>
  listDirectory(path: string): Promise<FileEntry[]>
}
