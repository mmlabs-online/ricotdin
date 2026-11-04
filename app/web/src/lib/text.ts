// Text written by other users (meeting titles, folder names) is shown without bidi controls or
// zero-width characters, which could reorder the surrounding UI text or make one name look like
// another (CWE-451). React already escapes it; this is about what it looks like.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g

export function displayText(text: string): string {
  return text.replace(INVISIBLE, '')
}
