import { describe, it, expect } from 'vitest'
import { applyVoiceEdit, importWake, type Raw } from './voice-cli'

const tts = (raw: Raw) => (raw.voice as Raw).tts as Raw

describe('applyVoiceEdit (pure voice config mutation)', () => {
  it('sets engine at voice.tts.engine, rejecting anything but local/openai', () => {
    expect(tts(applyVoiceEdit({}, 'engine', 'openai')).engine).toBe('openai')
    expect(tts(applyVoiceEdit({}, 'engine', 'local')).engine).toBe('local')
    expect(() => applyVoiceEdit({}, 'engine', 'azure')).toThrow()
  })

  it('sets speaker at voice.tts.voice', () => {
    expect(tts(applyVoiceEdit({}, 'speaker', 'bm_fable')).voice).toBe('bm_fable')
  })

  it('sets rate as a number, rejecting non-numeric', () => {
    expect(tts(applyVoiceEdit({}, 'rate', '1.1')).rate).toBe(1.1)
    expect(() => applyVoiceEdit({}, 'rate', 'fast')).toThrow()
  })

  it('sets openai.* fields under voice.tts.openai', () => {
    const out = applyVoiceEdit({}, 'openai.voice', 'ash')
    expect((tts(out).openai as Raw).voice).toBe('ash')
  })

  it('rejects an unknown openai field', () => {
    expect(() => applyVoiceEdit({}, 'openai.bogus', 'x')).toThrow()
  })

  it('sets the display phrase at voice.wake.phrase (preserving the pretrained word)', () => {
    const out = applyVoiceEdit(
      { voice: { wake: { word: 'hey_jarvis' } } },
      'wake.phrase',
      'hey timmy',
    )
    const wakeBlock = (out.voice as Raw).wake as Raw
    expect(wakeBlock.phrase).toBe('hey timmy')
    expect(wakeBlock.word).toBe('hey_jarvis') // pretrained fallback the daemon reads — untouched
  })

  it('preserves unrelated top-level config and sibling voice keys', () => {
    const start: Raw = { memory: { learning_mode: true }, voice: { tts: { engine: 'openai' } } }
    const out = applyVoiceEdit(start, 'speaker', 'bm_fable')
    expect(out.memory).toEqual({ learning_mode: true })
    expect(tts(out).engine).toBe('openai') // sibling within voice.tts preserved
    expect(tts(out).voice).toBe('bm_fable')
  })
})

describe('importWake (wake-model re-import)', () => {
  it('rejects a non-.tflite file', () => {
    expect(() => importWake('/tmp/model.onnx')).toThrow(/\.tflite/)
  })

  it('rejects a missing source file', () => {
    expect(() => importWake('/tmp/does-not-exist-xyz.tflite')).toThrow(/no such file/)
  })
})
