import { ApiError } from '../api/errors'
// Text written by other users (meeting titles, folder names) is shown without bidi controls or
// zero-width characters, which could reorder the surrounding UI text or make one name look like
// another (CWE-451). React already escapes it; this is about what it looks like.
// Same set as the API's rules.has_invisible_characters (SEC-05): control, format (bidi, zero-width,
// soft hyphen, tags), line / paragraph separators, plus invisible fillers. Emoji variation selectors stay.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034F\u115F\u1160\u17B4\u17B5\u3164\uFFA0]/gu

export function displayText(text: string): string {
  return text.replace(INVISIBLE, '')
}

/** The API refused a name that contains such characters (SEC-05). Matched by code, never text. */
export function isInvisibleCharactersError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'invalid_characters'
}
