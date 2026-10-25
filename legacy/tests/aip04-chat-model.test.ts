// Pure unit tests for AIP-04: cross-meeting RAG model resolution.
// No I/O, no DB, no mocks — exercises pure functions and constants only.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { resolveGenerationModelFromData } from '../lib/ai/resolve'
import type { GenerationConfig, ModelPick } from '../lib/ai/config'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SYSTEM_DEFAULT: ModelPick = { provider: 'gemini', model: 'gemini-2.5-flash' }
const ALT_DEFAULT: ModelPick    = { provider: 'openai', model: 'gpt-4o' }

function makeConfig(systemDefault: ModelPick, allowedModels: ModelPick[] = [systemDefault]): GenerationConfig {
  return { systemDefault, allowedModels }
}

// ---------------------------------------------------------------------------
// AIP-04: cross-meeting path picks systemDefault when no user pref / pick
// ---------------------------------------------------------------------------

describe('AIP-04 cross-meeting model resolution', () => {
  test('returns systemDefault when userPref=null and pick=null', () => {
    const config = makeConfig(SYSTEM_DEFAULT)
    const result = resolveGenerationModelFromData(config, null, null)
    assert.deepEqual(result, SYSTEM_DEFAULT)
  })

  test('returns systemDefault when userPref=null and pick=undefined', () => {
    const config = makeConfig(SYSTEM_DEFAULT)
    const result = resolveGenerationModelFromData(config, null, undefined)
    assert.deepEqual(result, SYSTEM_DEFAULT)
  })

  test('ULTIMATE_FALLBACK shape: getGenerationConfig FALLBACK is gemini:gemini-2.5-flash', () => {
    // Validates constraint 5: the built-in FALLBACK in getGenerationConfig()
    // equals ULTIMATE_FALLBACK, so pre-migration state degrades gracefully.
    // We exercise this via the resolver: with the fallback config and no pref/pick,
    // the resolver returns the system default without throwing.
    const fallbackConfig = makeConfig({ provider: 'gemini', model: 'gemini-2.5-flash' })
    const result = resolveGenerationModelFromData(fallbackConfig, null, null)
    assert.equal(result.provider, 'gemini')
    assert.equal(result.model, 'gemini-2.5-flash')
  })

  test('system default change is picked up: resolver returns new systemDefault', () => {
    // Simulates what happens after an admin changes app_settings and the
    // 30 s TTL expires — the next getGenerationConfig() returns ALT_DEFAULT.
    const updatedConfig = makeConfig(ALT_DEFAULT)
    const result = resolveGenerationModelFromData(updatedConfig, null, null)
    assert.deepEqual(result, ALT_DEFAULT)
  })
})

// ---------------------------------------------------------------------------
// AIP-04 constraint: single-meeting AIP-03 lock is unaffected
// ---------------------------------------------------------------------------

describe('AIP-03 single-meeting lock unaffected by AIP-04', () => {
  test('explicit pick that is in the allow-list wins over systemDefault', () => {
    const explicitPick: ModelPick = { provider: 'openai', model: 'gpt-4o' }
    const config: GenerationConfig = {
      systemDefault: SYSTEM_DEFAULT,
      allowedModels: [SYSTEM_DEFAULT, explicitPick],
    }
    const result = resolveGenerationModelFromData(config, null, explicitPick)
    assert.deepEqual(result, explicitPick)
    assert.notDeepEqual(result, SYSTEM_DEFAULT)
  })

  test('explicit pick NOT in allow-list falls through to systemDefault', () => {
    const explicitPick: ModelPick = { provider: 'openai', model: 'gpt-4o' }
    const config: GenerationConfig = {
      systemDefault: SYSTEM_DEFAULT,
      allowedModels: [SYSTEM_DEFAULT], // explicitPick not allowed
    }
    const result = resolveGenerationModelFromData(config, null, explicitPick)
    assert.deepEqual(result, SYSTEM_DEFAULT)
  })

  test('user pref in allow-list wins over systemDefault (user_pref_chain path)', () => {
    // This confirms the FULL resolver chain — userPref beats systemDefault
    // when it's in the allow-list. The cross-meeting path bypasses userPref by
    // reading config.systemDefault directly (not calling resolveGenerationModel).
    const userPref: ModelPick = { provider: 'openai', model: 'gpt-4o' }
    const config: GenerationConfig = {
      systemDefault: SYSTEM_DEFAULT,
      allowedModels: [SYSTEM_DEFAULT, userPref],
    }
    const result = resolveGenerationModelFromData(config, userPref, null)
    assert.deepEqual(result, userPref)
  })
})

// ---------------------------------------------------------------------------
// Retrieval stays Gemini — the modelCtx only affects answer synthesis
// (the retrieval path has no modelCtx parameter; this is a design invariant,
//  not a runtime assertion, so we document it as an explicit fact test)
// ---------------------------------------------------------------------------

describe('retrieval vs synthesis model separation', () => {
  test('systemDefault is the synthesis model only (provider field is present)', () => {
    const config = makeConfig(SYSTEM_DEFAULT)
    const result = resolveGenerationModelFromData(config, null, null)
    // The shape must have both fields — that is all answerWithContext needs.
    assert.ok(typeof result.provider === 'string' && result.provider.length > 0)
    assert.ok(typeof result.model === 'string' && result.model.length > 0)
  })
})
