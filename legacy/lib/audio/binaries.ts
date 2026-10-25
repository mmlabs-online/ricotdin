// SERVER ONLY — resolves the ffmpeg / ffprobe binary to invoke.
//
// We do NOT rely solely on PATH: a long-lived dev server (or a service) often
// has a stale PATH that doesn't include a freshly-installed ffmpeg, which made
// transcoding silently skip and submit raw WebM to Speechmatics (rejected as
// "invalid audio"). Resolution order:
//   1. Explicit env override: FFMPEG_PATH / FFPROBE_PATH (absolute path).
//   2. Known Windows winget install dir (Gyan.FFmpeg package).
//   3. Bare 'ffmpeg' / 'ffprobe' (found on PATH — the normal Linux/server case).
//
// The chosen value is cached for the process lifetime.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function fromEnv(envVar: string): string | null {
  const v = process.env[envVar]
  return v && existsSync(v) ? v : null
}

// Look under %LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg-*build\bin\<exe>
function fromWinget(exe: string): string | null {
  try {
    const pkgs = join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages')
    if (!existsSync(pkgs)) return null
    const pkgDir = readdirSync(pkgs).find((d) => d.startsWith('Gyan.FFmpeg'))
    if (!pkgDir) return null
    const buildDir = readdirSync(join(pkgs, pkgDir)).find((d) => /ffmpeg.*build/i.test(d))
    if (!buildDir) return null
    const binPath = join(pkgs, pkgDir, buildDir, 'bin', exe)
    return existsSync(binPath) ? binPath : null
  } catch {
    return null
  }
}

let cachedFfmpeg: string | null = null
let cachedFfprobe: string | null = null

export function ffmpegBinary(): string {
  if (!cachedFfmpeg) {
    cachedFfmpeg = fromEnv('FFMPEG_PATH') ?? fromWinget('ffmpeg.exe') ?? 'ffmpeg'
  }
  return cachedFfmpeg
}

export function ffprobeBinary(): string {
  if (!cachedFfprobe) {
    cachedFfprobe = fromEnv('FFPROBE_PATH') ?? fromWinget('ffprobe.exe') ?? 'ffprobe'
  }
  return cachedFfprobe
}
