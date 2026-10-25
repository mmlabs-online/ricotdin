'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { useUpload } from '@/lib/upload/useUpload'
import { getAccessToken } from '@/lib/supabase/auth'
import FolderSelector from '@/components/FolderSelector'
import {
  MAX_UPLOAD_BYTES,
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_VIDEO_EXTENSIONS,
  isAllowedExtension,
  isVideoExtension,
} from '@/lib/upload/constants'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function fileExtension(filename: string): string {
  const m = filename.match(/(\.[^.]+)$/)
  return m ? m[1].toLowerCase() : ''
}

/** Default value for a datetime-local input — local time, trimmed to minutes. */
function localNow(): string {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 16)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  onCancel: () => void
  /** Pre-selected folder (e.g. when the user came from a folder view). */
  initialFolderId?: string | null
}

export default function FileUploadSection({ onCancel, initialFolderId = null }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [meetingDate, setMeetingDate] = useState<string>(localNow())
  const [isVideo, setIsVideo] = useState(false)
  const [fileDuration, setFileDuration] = useState<number>(0)
  const [folderId, setFolderId] = useState<string | null>(initialFolderId)

  const { state, meetingId, error: uploadError, upload, reset } = useUpload()

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null
    setFile(null)
    setFileError(null)
    setIsVideo(false)
    setFileDuration(0)
    reset()

    if (!picked) return

    // Client-side extension check — accept both audio and video
    const ext = fileExtension(picked.name)
    if (!ext || (!isAllowedExtension(ext) && !isVideoExtension(ext))) {
      const allFormats = [...ALLOWED_AUDIO_EXTENSIONS, ...ALLOWED_VIDEO_EXTENSIONS].join(', ')
      setFileError(
        `Unsupported file type "${ext || 'unknown'}". ` +
          `Supported formats: ${allFormats}`,
      )
      return
    }

    // Client-side size check — reject immediately, no upload attempt
    if (picked.size > MAX_UPLOAD_BYTES) {
      const limit = formatBytes(MAX_UPLOAD_BYTES)
      setFileError(
        `File is too large (${formatBytes(picked.size)}). Maximum allowed size is ${limit}.`,
      )
      return
    }

    setIsVideo(isVideoExtension(ext))
    setFile(picked)

    // Read duration from media metadata (audio or video element, whichever fits).
    const url = URL.createObjectURL(picked)
    const media = document.createElement(isVideoExtension(ext) ? 'video' : 'audio')
    media.preload = 'metadata'
    media.onloadedmetadata = () => {
      setFileDuration(isFinite(media.duration) ? Math.round(media.duration) : 0)
      URL.revokeObjectURL(url)
    }
    media.onerror = () => {
      setFileDuration(0)
      URL.revokeObjectURL(url)
    }
    media.src = url
  }

  function handleUpload() {
    if (!file) return
    const ext = fileExtension(file.name)
    void upload(file, {
      durationSeconds: fileDuration,
      startedAt: new Date(meetingDate).toISOString(),
      mimeType: file.type || undefined,
      source: isVideo ? 'video' : 'uploaded',
      fileExtension: ext,
      folderId,
    })
  }

  const uploading = state === 'uploading'

  // ── Post-upload: move the created meeting to a folder ──────────────────────
  const [moveBusy, setMoveBusy] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)

  async function handleMoveToFolder(target: string | null) {
    if (!meetingId) return
    const prev = folderId
    setFolderId(target) // optimistic
    setMoveError(null)
    setMoveBusy(true)
    try {
      const token = await getAccessToken()
      if (!token) { setFolderId(prev); setMoveError('Not authenticated.'); return }
      const res = await fetch(`/api/meetings/${meetingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ folder_id: target }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        setFolderId(prev)
        setMoveError(j.error ?? 'Failed to move recording.')
      }
    } catch {
      setFolderId(prev)
      setMoveError('Network error.')
    } finally {
      setMoveBusy(false)
    }
  }

  // ── Reset everything to upload another file ────────────────────────────────
  function handleUploadAnother() {
    setFile(null)
    setFileError(null)
    setIsVideo(false)
    setFileDuration(0)
    setMeetingDate(localNow())
    setMoveError(null)
    if (inputRef.current) inputRef.current.value = ''
    reset()
    // folderId is intentionally kept so consecutive uploads can target the same folder.
  }

  return (
    <div className="flex flex-col gap-4 pt-4 border-t border-b-border">

      {/* File picker */}
      <div className="flex flex-col gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,.m4a,.wav,.aac,.ogg,.flac,.webm,audio/*,.mp4,.mov,.avi,.mkv,.m4v,video/*"
          className="sr-only"
          onChange={handleFileChange}
          disabled={uploading || state === 'done'}
        />
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => inputRef.current?.click()}
            disabled={uploading || state === 'done'}
          >
            Choose audio or video file
          </button>
          {file ? (
            <span className="text-sm text-b-fg/60 font-sans">
              {file.name} · {formatBytes(file.size)}
            </span>
          ) : (
            <span className="text-xs text-b-fg/40 font-sans">
              Audio: {ALLOWED_AUDIO_EXTENSIONS.join(' · ')}
              <br />
              Video: {ALLOWED_VIDEO_EXTENSIONS.join(' · ')} · max {formatBytes(MAX_UPLOAD_BYTES)}
            </span>
          )}
        </div>

        {/* Inline note when a video file is selected */}
        {file && isVideo && state !== 'done' && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs text-amber-700 font-sans">
            Video detected — only the audio track will be extracted and saved. The video file is not stored.
          </div>
        )}

        {fileError && (
          <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-sm text-red-700 font-sans">
            {fileError}
          </div>
        )}
      </div>

      {/* Meeting date — only shown once a valid file is chosen */}
      {file && state !== 'done' && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-b-fg/60 font-sans uppercase tracking-wide">
            When did this meeting happen?
          </label>
          <input
            type="datetime-local"
            value={meetingDate}
            onChange={(e) => setMeetingDate(e.target.value)}
            disabled={uploading}
            className="w-full rounded-xl border border-b-border bg-b-clay px-3 py-2 text-sm font-sans text-b-fg focus:outline-none focus:ring-2 focus:ring-b-primary/40 disabled:opacity-50"
          />
          <p className="text-xs text-b-fg/40 font-sans">
            Used to resolve dates in todos and calendar suggestions (e.g. &ldquo;next Tuesday&rdquo;).
          </p>
        </div>
      )}

      {/* Folder selector — only shown once a valid file is chosen */}
      {file && state !== 'done' && (
        <FolderSelector
          value={folderId}
          onChange={setFolderId}
          disabled={uploading}
        />
      )}

      {/* Upload action */}
      {file && state === 'idle' && (
        <button className="btn-primary self-start" onClick={handleUpload}>
          ↑ Upload and process
        </button>
      )}

      {uploading && (
        <div className="flex items-center gap-3 rounded-2xl border border-b-primary/30 bg-b-clay px-4 py-3">
          <span
            className="inline-block w-5 h-5 shrink-0 rounded-full border-2 border-b-primary/25 border-t-b-primary animate-spin"
            aria-hidden="true"
          />
          <span className="text-sm text-b-fg/70 font-sans">
            {isVideo
              ? 'Uploading video and extracting audio… this may take a minute'
              : 'Uploading… this may take a moment for large files'}
          </span>
        </div>
      )}

      {state === 'error' && (
        <div className="flex flex-col gap-2">
          <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-sm text-red-700 font-sans">
            {uploadError}
          </div>
          <button onClick={reset} className="btn-secondary self-start text-xs px-4 py-1.5">
            Try again
          </button>
        </div>
      )}

      {state === 'done' && meetingId && (
        <div className="flex flex-col gap-4">
          <div className="bg-b-clay border border-b-primary/30 rounded-2xl px-4 py-3 text-sm text-b-fg font-sans">
            ✓ Uploaded! Your recording is now processing.
          </div>

          {/* Move the uploaded recording to a folder */}
          <FolderSelector
            value={folderId}
            onChange={(f) => { void handleMoveToFolder(f) }}
            disabled={moveBusy}
          />
          {moveError && <p className="text-xs text-red-500 font-sans">{moveError}</p>}

          {/* Actions */}
          <div className="flex items-center gap-3 flex-wrap">
            <Link href={`/meetings/${meetingId}`} className="btn-primary">
              View recording →
            </Link>
            <button type="button" onClick={handleUploadAnother} className="btn-secondary">
              ↑ Upload another file
            </button>
            <Link href="/meetings" className="text-sm text-b-terra font-semibold font-sans hover:underline">
              All meetings
            </Link>
          </div>
        </div>
      )}

      {/* Cancel — hidden once upload is done */}
      {state !== 'done' && (
        <button
          type="button"
          onClick={onCancel}
          disabled={uploading}
          className="self-start text-xs text-b-fg/40 font-sans hover:text-b-fg/60 transition-colors disabled:opacity-40"
        >
          ← Back to recording
        </button>
      )}
    </div>
  )
}
