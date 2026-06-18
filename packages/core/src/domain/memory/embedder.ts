import { Context, Effect, Layer } from 'effect'
import { Config } from '../config/config'

export interface EmbedderImpl {
  /** Embed text → vector, or null if embedding is unavailable (caller falls back to keyword match). */
  readonly embed: (text: string) => Effect.Effect<Float32Array | null>
}

/** Default: a small multilingual sentence-embedding model that runs IN-PROCESS (transformers.js /
 *  onnxruntime) — no Ollama, no server, no API key. Multilingual so EN + ID memories rank correctly.
 *  Override with `models.embedding` (any transformers.js model id, e.g. an English-only or larger one). */
export const DEFAULT_EMBED_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'

/** The injected embed function: text → vector (or null when unavailable). May throw — the wrapper
 *  below catches everything so `embed` NEVER fails (recall degrades to keyword match on null). */
export type EmbedFn = (text: string) => Promise<number[] | null>

/** Pure factory (testable with an injected `embedFn`). Never throws — returns null on any failure. */
export function makeEmbedder(embedFn: EmbedFn): EmbedderImpl {
  return {
    embed: (text) =>
      Effect.tryPromise(() => embedFn(text)).pipe(
        Effect.map((v) => (v && v.length > 0 ? new Float32Array(v) : null)),
        Effect.catchAll(() => Effect.succeed(null)),
      ),
  }
}

// transformers.js is ESM-only and heavy; import it lazily on first use (one pipeline, reused) so it
// never loads for a chat that doesn't touch memory, and the daemon starts fast.
type FeaturePipeline = (
  text: string,
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array }>

let pipelinePromise: Promise<FeaturePipeline> | null = null
const loadPipeline = (model: string): Promise<FeaturePipeline> => {
  if (!pipelinePromise) {
    pipelinePromise = import('@huggingface/transformers').then(
      ({ pipeline }) =>
        pipeline('feature-extraction', model) as unknown as Promise<FeaturePipeline>,
    )
  }
  return pipelinePromise
}

/** Build the in-process embed fn for `model`. The first call downloads the model (~120MB, cached in
 *  ~/.cache/huggingface) then loads it; subsequent calls are a few ms. */
export function localEmbedFn(model: string): EmbedFn {
  return async (text: string) => {
    const pipe = await loadPipeline(model)
    const out = await pipe(text, { pooling: 'mean', normalize: true })
    return Array.from(out.data)
  }
}

export class Embedder extends Context.Tag('timmy/memory/embedder')<Embedder, EmbedderImpl>() {
  static Live = Layer.effect(
    Embedder,
    Effect.gen(function* () {
      const cfg = yield* (yield* Config).get
      const model = cfg.models.embedding ?? DEFAULT_EMBED_MODEL
      return makeEmbedder(localEmbedFn(model))
    }),
  )
}
