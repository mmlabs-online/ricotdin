// Unit tests for AIP-06 control-plane pure helpers.
// All pure — no I/O, no live provider calls, no DB reads.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveModel, listRegistered, getDefaultGenerationModel } from '../lib/ai/registry.js'
import { isModelAllowed } from '../lib/ai/config.js'
import { resolveGenerationModelFromData } from '../lib/ai/resolve.js'
import type { GenerationConfig, ModelPick } from '../lib/ai/config.js'

// ── Fixture configs ───────────────────────────────────────────────────────────

const ALL_ALLOWED: GenerationConfig = {
  systemDefault: { provider: 'gemini', model: 'gemini-2.5-flash' },
  allowedModels: [
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'openai', model: 'gpt-4o-mini' },
  ],
}

const GEMINI_ONLY: GenerationConfig = {
  systemDefault: { provider: 'gemini', model: 'gemini-2.5-flash' },
  allowedModels: [
    { provider: 'gemini', model: 'gemini-2.5-flash' },
  ],
}

const EMPTY_ALLOW: GenerationConfig = {
  systemDefault: { provider: 'gemini', model: 'gemini-2.5-flash' },
  allowedModels: [],
}

// ── listRegistered ────────────────────────────────────────────────────────────

describe('listRegistered (AIP-06)', () => {
  it('returns an array', () => {
    const entries = listRegistered()
    assert.ok(Array.isArray(entries))
    assert.ok(entries.length >= 3)
  })

  it('includes gemini:gemini-2.5-flash', () => {
    assert.ok(listRegistered().some((e) => e.provider === 'gemini' && e.model === 'gemini-2.5-flash'))
  })

  it('includes openai:gpt-4o', () => {
    assert.ok(listRegistered().some((e) => e.provider === 'openai' && e.model === 'gpt-4o'))
  })

  it('includes openai:gpt-4o-mini', () => {
    assert.ok(listRegistered().some((e) => e.provider === 'openai' && e.model === 'gpt-4o-mini'))
  })

  it('each entry has the required interface shape', () => {
    for (const e of listRegistered()) {
      assert.ok(typeof e.provider === 'string', 'provider must be string')
      assert.ok(typeof e.model === 'string', 'model must be string')
      assert.ok(typeof e.adapter?.generateStructured === 'function', 'adapter.generateStructured required')
      assert.ok(typeof e.adapter?.generateText === 'function', 'adapter.generateText required')
      assert.ok(typeof e.capabilities?.maxContextTokens === 'number', 'capabilities.maxContextTokens required')
    }
  })
})

// ── isModelAllowed ────────────────────────────────────────────────────────────

describe('isModelAllowed (AIP-06)', () => {
  it('returns true for gemini:gemini-2.5-flash in ALL_ALLOWED', () => {
    assert.ok(isModelAllowed('gemini', 'gemini-2.5-flash', ALL_ALLOWED))
  })

  it('returns true for openai:gpt-4o in ALL_ALLOWED', () => {
    assert.ok(isModelAllowed('openai', 'gpt-4o', ALL_ALLOWED))
  })

  it('returns true for openai:gpt-4o-mini in ALL_ALLOWED', () => {
    assert.ok(isModelAllowed('openai', 'gpt-4o-mini', ALL_ALLOWED))
  })

  it('returns false for openai:gpt-4o when not in GEMINI_ONLY allow-list', () => {
    assert.equal(isModelAllowed('openai', 'gpt-4o', GEMINI_ONLY), false)
  })

  it('returns false for openai:gpt-4o-mini when not in GEMINI_ONLY allow-list', () => {
    assert.equal(isModelAllowed('openai', 'gpt-4o-mini', GEMINI_ONLY), false)
  })

  it('returns false for a model in allow-list but NOT in the registry', () => {
    const withPhantom: GenerationConfig = {
      ...ALL_ALLOWED,
      allowedModels: [...ALL_ALLOWED.allowedModels, { provider: 'anthropic', model: 'claude-opus' }],
    }
    assert.equal(isModelAllowed('anthropic', 'claude-opus', withPhantom), false)
  })

  it('returns false for empty allow-list', () => {
    assert.equal(isModelAllowed('gemini', 'gemini-2.5-flash', EMPTY_ALLOW), false)
  })

  it('returns false for completely unknown provider', () => {
    assert.equal(isModelAllowed('unknown-provider', 'some-model', ALL_ALLOWED), false)
  })
})

// ── resolveGenerationModelFromData ────────────────────────────────────────────

describe('resolveGenerationModelFromData (AIP-06)', () => {
  const GPT4O: ModelPick  = { provider: 'openai', model: 'gpt-4o' }
  const GEMINI: ModelPick = { provider: 'gemini', model: 'gemini-2.5-flash' }
  const MINI: ModelPick   = { provider: 'openai', model: 'gpt-4o-mini' }

  it('returns explicit pick when valid and allowed', () => {
    assert.deepEqual(resolveGenerationModelFromData(ALL_ALLOWED, null, GPT4O), GPT4O)
  })

  it('falls through to user pref when pick is not in allow-list', () => {
    const result = resolveGenerationModelFromData(GEMINI_ONLY, GEMINI, GPT4O)
    assert.deepEqual(result, GEMINI) // GPT4O not allowed, falls to user pref
  })

  it('returns system default when pick is null and no user pref', () => {
    assert.deepEqual(resolveGenerationModelFromData(ALL_ALLOWED, null, null), GEMINI)
  })

  it('uses user pref when pick is null', () => {
    assert.deepEqual(resolveGenerationModelFromData(ALL_ALLOWED, MINI, null), MINI)
  })

  it('uses user pref when pick is undefined', () => {
    assert.deepEqual(resolveGenerationModelFromData(ALL_ALLOWED, MINI, undefined), MINI)
  })

  it('falls through to system default when user pref is not in allow-list', () => {
    assert.deepEqual(resolveGenerationModelFromData(GEMINI_ONLY, GPT4O, null), GEMINI)
  })

  it('pick wins over user pref when both valid', () => {
    assert.deepEqual(resolveGenerationModelFromData(ALL_ALLOWED, MINI, GPT4O), GPT4O)
  })

  it('zero behavior change: no inputs → gemini:gemini-2.5-flash (system default)', () => {
    const config: GenerationConfig = {
      systemDefault: { provider: 'gemini', model: 'gemini-2.5-flash' },
      allowedModels: [{ provider: 'gemini', model: 'gemini-2.5-flash' }],
    }
    const result = resolveGenerationModelFromData(config, null, null)
    assert.equal(result.provider, 'gemini')
    assert.equal(result.model, 'gemini-2.5-flash')
  })

  it('returns system default even when allow-list is empty (safety valve)', () => {
    const result = resolveGenerationModelFromData(EMPTY_ALLOW, null, null)
    assert.deepEqual(result, EMPTY_ALLOW.systemDefault)
  })

  it('pick that is not in registry is also rejected', () => {
    const phantomPick: ModelPick = { provider: 'anthropic', model: 'claude-opus' }
    const withPhantom: GenerationConfig = {
      ...ALL_ALLOWED,
      allowedModels: [...ALL_ALLOWED.allowedModels, phantomPick],
    }
    // phantom is in allow-list but not in registry → isModelAllowed returns false
    // falls through to user pref
    const result = resolveGenerationModelFromData(withPhantom, GEMINI, phantomPick)
    assert.deepEqual(result, GEMINI)
  })
})

// ── Registry cross-check ──────────────────────────────────────────────────────

describe('registry cross-check (AIP-06)', () => {
  it('getDefaultGenerationModel still returns gemini:gemini-2.5-flash', () => {
    const def = getDefaultGenerationModel()
    assert.equal(def.provider, 'gemini')
    assert.equal(def.model, 'gemini-2.5-flash')
  })

  it('all seed allowed_models are resolvable in the registry', () => {
    const seeds = [
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'openai', model: 'gpt-4o-mini' },
    ]
    for (const { provider, model } of seeds) {
      assert.doesNotThrow(
        () => resolveModel(provider, model),
        `${provider}:${model} must be resolvable in the registry`,
      )
    }
  })
})
