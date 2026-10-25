// SERVER ONLY.
// AIP-06: single authority for resolving the generation model for a request.
//
// Fallback chain (highest priority first):
//   1. Explicit pick passed from the record/upload UI
//   2. PRF-08 — user's stored default (profiles.default_provider/model)
//   3. ADM-10 — system default (app_settings: generation.system_default)

import { getGenerationConfig, isModelAllowed, loadUserModelPref } from './config'
import type { ModelPick, GenerationConfig } from './config'

export type { ModelPick }

// ---------------------------------------------------------------------------
// Pure resolver (testable with no I/O)
// ---------------------------------------------------------------------------

/**
 * Resolve the best model from pre-loaded data.
 * Pure: all inputs explicit, no DB reads.
 */
export function resolveGenerationModelFromData(
  config: GenerationConfig,
  userPref: ModelPick | null,
  pick: ModelPick | null | undefined,
): ModelPick {
  // 1. Explicit pick — only if still in the allow-list + registry.
  if (pick && isModelAllowed(pick.provider, pick.model, config)) return pick

  // 2. PRF-08: user's stored preference (re-validated against current allow-list).
  if (userPref && isModelAllowed(userPref.provider, userPref.model, config)) return userPref

  // 3. ADM-10: system default (always valid by construction).
  return config.systemDefault
}

// ---------------------------------------------------------------------------
// Async resolver (production entry point)
// ---------------------------------------------------------------------------

/**
 * Resolve the generation model for a new job.
 * Reads the current allow-list + system default from DB and the user's stored
 * preference, then applies the fallback chain.
 *
 * This is the SINGLE entry point replacing the AIP-03 placeholder
 * (getDefaultGenerationModel) everywhere in the pipeline.
 */
export async function resolveGenerationModel(
  userId: string | null | undefined,
  pick?: ModelPick | null,
): Promise<ModelPick> {
  const [config, userPref] = await Promise.all([
    getGenerationConfig(),
    loadUserModelPref(userId),
  ])
  return resolveGenerationModelFromData(config, userPref, pick ?? null)
}
