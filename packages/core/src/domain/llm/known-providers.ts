/** Built-in base URLs for well-known cloud providers, so a config `providers` entry can
 *  omit `base_url` for them (e.g. `deepseek: { kind: openai-compat }`). A configured
 *  `base_url` always wins — for self-hosted, a proxy, or a provider we don't know. */
export const KNOWN_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  anthropic: 'https://api.anthropic.com/v1', // OpenAI-compatible endpoint
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai', // OpenAI-compatible endpoint
}

/** Configured base_url wins; otherwise fall back to the known URL for this provider key. */
export const resolveBaseUrl = (providerKey: string, configured?: string): string | undefined =>
  configured ?? KNOWN_BASE_URLS[providerKey]
