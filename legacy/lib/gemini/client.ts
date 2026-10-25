// SERVER ONLY — this module re-exports shared Gemini constants and a simple
// text-generation helper. All Gemini calls must go through /lib/gemini service
// functions so we can swap models or switch free↔paid in one place.
//
// The key pool (multi-key round-robin + retry) lives in ./pool.
// The service functions (transcribeAudio, embedChunks, …) wrap pool.call().
// Nothing outside /lib/gemini/ should import @google/genai directly.

import { geminiPool } from './pool'

export const GEMINI_MODEL = 'gemini-2.5-flash' as const
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001' as const
export const EMBEDDING_DIMENSION = 768 as const

/**
 * Send a plain text prompt to Gemini and return the text response.
 * Used by connectivity checks and simple generation tasks.
 */
export async function generateText(prompt: string): Promise<string> {
  const response = await geminiPool.call(ai =>
    ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    }),
  )
  const text = response.text
  if (text === undefined) {
    throw new Error('Gemini returned an empty response.')
  }
  return text
}
