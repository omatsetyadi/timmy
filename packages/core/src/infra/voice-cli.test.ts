import { describe, it, expect } from 'vitest'
import { applyVoiceEdit, applyVoiceTunable, importWake, type Raw } from './voice-cli'

const tts = (raw: Raw) => (raw.voice as Raw).tts as Raw
const conv = (raw: Raw) => (raw.voice as Raw).conversation as Raw

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

describe('applyVoiceTunable (full_duplex + conversation knobs)', () => {
  it('sets full_duplex as a boolean at voice.full_duplex (true/false/on/off)', () => {
    expect((applyVoiceTunable({}, 'full_duplex', 'false').voice as Raw).full_duplex).toBe(false)
    expect((applyVoiceTunable({}, 'full_duplex', 'on').voice as Raw).full_duplex).toBe(true)
  })

  it('sets a float knob under voice.conversation', () => {
    expect(conv(applyVoiceTunable({}, 'smart_turn_threshold', '0.7')).smart_turn_threshold).toBe(
      0.7,
    )
  })

  it('sets an int knob under voice.conversation', () => {
    expect(conv(applyVoiceTunable({}, 'end_silence_ms', '800')).end_silence_ms).toBe(800)
  })

  it('sets the boolean smart_turn under voice.conversation', () => {
    expect(conv(applyVoiceTunable({}, 'smart_turn', 'off')).smart_turn).toBe(false)
  })

  it('rejects an unknown key, a non-numeric number, and a non-boolean', () => {
    expect(() => applyVoiceTunable({}, 'bogus', '1')).toThrow(/unknown/i)
    expect(() => applyVoiceTunable({}, 'end_silence_ms', 'lots')).toThrow(/integer/i)
    expect(() => applyVoiceTunable({}, 'full_duplex', 'maybe')).toThrow(/true.*false/i)
  })

  it('sets voice.autostart (core-read) as a top-level boolean', () => {
    expect((applyVoiceTunable({}, 'autostart', 'on').voice as Raw).autostart).toBe(true)
    expect((applyVoiceTunable({}, 'autostart', 'off').voice as Raw).autostart).toBe(false)
  })

  it('preserves unrelated config and sibling conversation keys', () => {
    const start: Raw = { voice: { conversation: { smart_turn: true }, tts: { engine: 'openai' } } }
    const out = applyVoiceTunable(start, 'follow_up_secs', '20')
    expect(conv(out).follow_up_secs).toBe(20)
    expect(conv(out).smart_turn).toBe(true) // sibling preserved
    expect(tts(out).engine).toBe('openai') // sibling voice block preserved
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
