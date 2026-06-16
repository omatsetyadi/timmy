import { Context, Effect, Layer } from 'effect'
import { Config, effectiveProviders } from '../config/config'
import { resolveBaseUrl } from '../llm/known-providers'

export interface EmbedderImpl {
  /** Embed text → vector, or null if embedding is unavailable (caller falls back to keyword match). */
  readonly embed: (text: string) => Effect.Effect<Float32Array | null>
}

type Post = (
  url: string,
  body: unknown,
) => Promise<{ ok: boolean; json: () => Promise<{ embedding?: number[] }> }>

/** Pure factory (testable with an injected `post`). Never throws — returns null on any failure. */
export function makeEmbedder(opts: { model: string; baseUrl: string; post: Post }): EmbedderImpl {
  return {
    embed: (text) =>
      Effect.tryPromise(() =>
        opts.post(`${opts.baseUrl}/api/embeddings`, { model: opts.model, prompt: text }),
      ).pipe(
        Effect.flatMap((r) =>
          r.ok
            ? Effect.promise(() => r.json()).pipe(
                Effect.map((d) => (d.embedding ? new Float32Array(d.embedding) : null)),
              )
            : Effect.succeed(null),
        ),
        Effect.catchAll(() => Effect.succeed(null)),
      ),
  }
}

export class Embedder extends Context.Tag('timmy/memory/embedder')<Embedder, EmbedderImpl>() {
  static Live = Layer.effect(
    Embedder,
    Effect.gen(function* () {
      const cfg = yield* (yield* Config).get
      const providers = effectiveProviders(cfg)
      const ollama = providers['ollama']
      const baseUrl = resolveBaseUrl('ollama', ollama?.base_url) ?? 'http://localhost:11434'
      const model = cfg.models.embedding ?? 'nomic-embed-text'
      const post: Post = (url, body) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      return makeEmbedder({ model, baseUrl, post })
    }),
  )
}
