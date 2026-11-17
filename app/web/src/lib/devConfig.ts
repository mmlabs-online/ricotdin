// Dev only (OPS-08). The dev server's own `/config.json` names the proxy prefix; the API is then
// reached same-origin under it. Called only under `import.meta.env.DEV`, so it is not in the build.

import type { RuntimeConfig } from './config'

const PREFIX = '/__dev_api'

export function withDevProxy(raw: unknown, config: RuntimeConfig): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null || (raw as { devProxy?: unknown }).devProxy !== PREFIX) return config
  return { ...config, apiUrl: `${config.apiUrl}${PREFIX}`, devProxy: true }
}
