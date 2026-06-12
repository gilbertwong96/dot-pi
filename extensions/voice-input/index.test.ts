import { afterEach, describe, expect, test } from 'bun:test'

import { buildRealtimeParams, formatRealtimeError, getVoiceInputConfig } from './index'

const ORIGINAL_ENV = { ...process.env }

function resetElevenLabsEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ELEVENLABS_')) delete process.env[key]
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (key.startsWith('ELEVENLABS_') && value !== undefined) process.env[key] = value
  }
}

afterEach(() => {
  resetElevenLabsEnv()
})

describe('getVoiceInputConfig', () => {
  test('requires an ElevenLabs API key', () => {
    delete process.env.ELEVENLABS_API_KEY

    expect(getVoiceInputConfig()).toEqual({ ok: false, message: 'ELEVENLABS_API_KEY not set' })
  })

  test('parses optional realtime transcription settings', () => {
    process.env.ELEVENLABS_API_KEY = 'test-key'
    process.env.ELEVENLABS_LANGUAGE = 'ru'
    process.env.ELEVENLABS_KEYTERMS = 'Pi, Scribe\nTypeScript'
    process.env.ELEVENLABS_COMMIT_STRATEGY = 'vad'
    process.env.ELEVENLABS_VAD_SILENCE_THRESHOLD_SECS = '1.25'
    process.env.ELEVENLABS_VAD_THRESHOLD = '0.35'
    process.env.ELEVENLABS_MIN_SPEECH_DURATION_MS = '150'
    process.env.ELEVENLABS_MIN_SILENCE_DURATION_MS = '200'

    expect(getVoiceInputConfig()).toEqual({
      ok: true,
      config: {
        apiKey: 'test-key',
        languageCode: 'ru',
        keyterms: ['Pi', 'Scribe', 'TypeScript'],
        commitStrategy: 'vad',
        vadSilenceThresholdSecs: 1.25,
        vadThreshold: 0.35,
        minSpeechDurationMs: 150,
        minSilenceDurationMs: 200
      }
    })
  })

  test('rejects invalid numeric settings', () => {
    process.env.ELEVENLABS_API_KEY = 'test-key'
    process.env.ELEVENLABS_VAD_THRESHOLD = 'loud'

    expect(getVoiceInputConfig()).toEqual({
      ok: false,
      message: 'ELEVENLABS_VAD_THRESHOLD must be a number'
    })
  })
})

describe('buildRealtimeParams', () => {
  test('includes optional realtime query parameters', () => {
    const params = buildRealtimeParams({
      apiKey: 'test-key',
      languageCode: 'en',
      keyterms: ['Earendil', 'Pi'],
      commitStrategy: 'vad',
      vadSilenceThresholdSecs: 1.5,
      vadThreshold: 0.4,
      minSpeechDurationMs: 100,
      minSilenceDurationMs: 250
    })

    expect(params.get('model_id')).toBe('scribe_v2_realtime')
    expect(params.get('audio_format')).toBe('pcm_16000')
    expect(params.get('language_code')).toBe('en')
    expect(params.get('commit_strategy')).toBe('vad')
    expect(params.get('vad_silence_threshold_secs')).toBe('1.5')
    expect(params.get('vad_threshold')).toBe('0.4')
    expect(params.get('min_speech_duration_ms')).toBe('100')
    expect(params.get('min_silence_duration_ms')).toBe('250')
    expect(params.getAll('keyterms')).toEqual(['Earendil', 'Pi'])
  })
})

describe('formatRealtimeError', () => {
  test('adds human labels for structured ElevenLabs errors', () => {
    expect(formatRealtimeError('auth_error', 'invalid api key')).toBe(
      'Authentication error: invalid api key'
    )
    expect(formatRealtimeError('queue_overflow', 'try again')).toBe('Queue overflow: try again')
  })
})
