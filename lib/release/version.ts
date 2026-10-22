// Resolves the running app's version for GET /version.json.
// RICOTDIN_VERSION is set at runtime by the deployment repo's release.env;
// BUILD_COMMIT is baked into the image at build time as a fallback.

export interface AppVersionInput {
  version?: string
  commit?: string
}

export function resolveAppVersion({ version, commit }: AppVersionInput): string {
  return version?.trim() || commit?.trim() || 'unknown'
}
