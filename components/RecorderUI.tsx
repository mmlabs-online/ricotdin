'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useRecorder } from '@/lib/audio/useRecorder'
import { checkRecordingSupport } from '@/lib/audio/support'
import { useUpload } from '@/lib/upload/useUpload'
import { getAccessToken } from '@/lib/supabase/auth'
import FileUploadSection from '@/components/FileUploadSection'
import FolderSelector from '@/components/FolderSelector'
import RecordingNoticeModal from '@/components/RecordingNoticeModal'
import { browserClient } from '@/lib/supabase/browser'
import { RECORDING_NOTICE_STORAGE_KEY, isNoticeAckFresh, parseStoredAck } from '@/lib/consent/recordingNotice'

// COM-01: the notice acknowledgement lives in sessionStorage (per tab). Kept outside the
// component: these run only from click handlers, never during render.
function isNoticeAcknowledged(): boolean {
  try {
    return isNoticeAckFresh(parseStoredAck(sessionStorage.getItem(RECORDING_NOTICE_STORAGE_KEY)), Date.now())
  } catch {
    return false // storage blocked → always show the notice
  }
}

function storeNoticeAcknowledged(): void {
  try { sessionStorage.setItem(RECORDING_NOTICE_STORAGE_KEY, String(Date.now())) } catch { /* storage blocked */ }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0')
  const s = (seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export default function RecorderUI({ initialFolderId = null }: { initialFolderId?: string | null }) {
  const {
    state, elapsedSeconds, blob, objectUrl, mimeType, trackInfo, error,
    supported, start, stop, reset,
  } = useRecorder()

  const [missingCapabilities, setMissingCapabilities] = useState<string[]>([])
  useEffect(() => { setMissingCapabilities(checkRecordingSupport().missingCapabilities) }, [])

  const { state: uploadState, meetingId, error: uploadError, upload, reset: resetUpload } = useUpload()
  const startedAtRef = useRef<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [folderId, setFolderId] = useState<string | null>(initialFolderId)
  const [moveBusy, setMoveBusy] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)

  // ── COM-01: recording notice ────────────────────────────────────────────────
  const [showNotice, setShowNotice] = useState(false)

  function beginRecording() {
    startedAtRef.current = new Date().toISOString()
    void start()
  }

  function handleStartClick() {
    if (isNoticeAcknowledged()) beginRecording()
    else setShowNotice(true)
  }

  function handleNoticeAcknowledge() {
    setShowNotice(false)
    storeNoticeAcknowledged()
    // Start first, synchronously inside the click, so the browser's screen-share prompt keeps
    // its user activation; the compliance log below is best-effort.
    beginRecording()
    void logNoticeAck()
  }

  async function logNoticeAck() {
    try {
      const { data: { session } } = await browserClient.auth.getSession()
      if (!session) return
      const res = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ eventType: 'recording_notice_ack', userId: session.user.id }),
      })
      if (!res.ok) console.warn(`[recording notice] acknowledgement was not logged (HTTP ${res.status})`)
    } catch {
      console.warn('[recording notice] acknowledgement was not logged (network error)')
    }
  }

  // ── AIP-06: optional model pick ─────────────────────────────────────────────
  const [modelPick, setModelPick] = useState<string>('') // "provider:model" or "" = auto
  const [allowedModels, setAllowedModels] = useState<Array<{ provider: string; model: string; label: string }>>([])
  useEffect(() => {
    const token = getAccessToken()
    void token.then((t) => {
      if (!t) return
      fetch('/api/profile/preferences', { headers: { Authorization: `Bearer ${t}` } })
        .then((r) => r.ok ? r.json() : null)
        .then((data: { provider: string | null; model: string | null; allowedModels: Array<{ provider: string; model: string; label: string }> } | null) => {
          if (!data) return
          setAllowedModels(data.allowedModels ?? [])
          if (data.provider && data.model) setModelPick(`${data.provider}:${data.model}`)
        })
        .catch(() => {})
    })
  }, [])

  // Post-upload: move the created meeting to a folder.
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

  // ── Unsupported browser ────────────────────────────────────────────────

  if (!supported) {
    return (
      <div className="card-botanical">
        <h2 className="font-serif text-xl font-bold text-red-600 mb-3">Browser not supported</h2>
        <p className="text-sm text-b-fg/70 font-sans mb-3">This browser is missing required capabilities:</p>
        <ul className="list-disc pl-5 text-sm text-b-fg/70 font-sans mb-4 space-y-1">
          {missingCapabilities.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <p className="text-sm text-b-fg/60 font-sans">
          Use <strong className="text-b-fg">Chrome 74+</strong> or <strong className="text-b-fg">Edge 79+</strong>.
          Firefox and Safari do not reliably expose system/tab audio.
        </p>
      </div>
    )
  }

  const ext = mimeType?.split('/')[1]?.split(';')[0] ?? 'webm'

  return (
    <div className="card-botanical flex flex-col gap-5">
      {showNotice && (
        <RecordingNoticeModal onAcknowledge={handleNoticeAcknowledge} onCancel={() => setShowNotice(false)} />
      )}

      {/* Pre-start instructions */}
      {state === 'idle' && (
        <div className="bg-b-clay border border-b-border rounded-2xl px-4 py-4 text-sm text-b-fg/70 font-sans leading-relaxed">
          <p className="font-semibold text-b-fg mb-2">Audio-only recording</p>
          <ul className="list-disc pl-4 space-y-1.5 text-b-fg/60">
            <li>
              Captures your <strong className="text-b-fg">microphone</strong> mixed with{' '}
              <strong className="text-b-fg">tab or window audio</strong>. Video is{' '}
              <strong className="text-b-fg">never recorded or saved</strong> — it only triggers the browser&apos;s sharing dialog.
            </li>
            <li>
              In the dialog: choose <em>This Tab</em> (recommended on Chrome), then tick{' '}
              <strong className="text-b-fg">&ldquo;Share tab audio&rdquo;</strong> before clicking Share.
              Without that checkbox only your mic is recorded.
            </li>
          </ul>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-4">
        {state === 'idle' && !showUpload && (
          <button
            className="btn-primary"
            onClick={handleStartClick}
          >
            <span className="text-red-400">●</span> Start recording
          </button>
        )}

        {state === 'idle' && !showUpload && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowUpload(true)}
          >
            ↑ Upload a file
          </button>
        )}

        {state === 'recording' && (
          <>
            <span className="font-mono text-2xl font-bold text-b-terra tracking-widest">
              ⏺ {formatTime(elapsedSeconds)}
            </span>
            <button
              onClick={stop}
              className="px-6 py-2.5 rounded-full bg-b-terra text-white text-sm font-semibold uppercase tracking-widest border-0 cursor-pointer hover:opacity-90 transition-opacity"
            >
              ■ Stop
            </button>
          </>
        )}

        {(state === 'stopped' || state === 'error') && (
          <button
            onClick={() => { reset(); resetUpload(); startedAtRef.current = null; setMoveError(null); setFolderId(initialFolderId) }}
            className="btn-secondary"
          >
            ↺ Record another
          </button>
        )}
      </div>

      {/* File upload section — shown when user picks "Upload a file" in idle state */}
      {state === 'idle' && showUpload && (
        <FileUploadSection onCancel={() => setShowUpload(false)} initialFolderId={initialFolderId} />
      )}

      {/* No system audio warning */}
      {state === 'recording' && trackInfo && !trackInfo.hasDisplayAudio && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm text-amber-700 font-sans">
          <strong>No system audio detected.</strong> Only your microphone is recording.
          Stop and share again — tick <em>&ldquo;Share tab audio&rdquo;</em> in the picker.
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-sm text-red-700 font-sans">
          {error}
        </div>
      )}

      {/* Playback + download */}
      {state === 'stopped' && objectUrl && (
        <div className="flex flex-col gap-3">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls src={objectUrl} className="w-full rounded-xl" />
          <div className="flex items-center gap-3 flex-wrap">
            <a
              href={objectUrl}
              download={`recording.${ext}`}
              className="text-sm text-b-primary font-sans hover:underline"
            >
              ↓ Download (.{ext})
            </a>
            {blob && (
              <span className="text-xs text-b-fg/40 font-sans">
                {(blob.size / 1024).toFixed(1)} KB · {mimeType}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Save recording */}
      {state === 'stopped' && blob && (
        <div className="border-t border-b-border pt-5 flex flex-col gap-4">
          {uploadState === 'idle' && (
            <FolderSelector
              value={folderId}
              onChange={setFolderId}
              disabled={false}
            />
          )}
          {/* Optional model picker — shown when admin allow-list has > 1 option */}
          {uploadState === 'idle' && allowedModels.length > 1 && (
            <div className="flex items-center gap-3">
              <label className="text-xs font-semibold text-b-fg/60 font-sans shrink-0">AI model</label>
              <select
                value={modelPick}
                onChange={(e) => setModelPick(e.target.value)}
                className="text-sm border border-b-border rounded-lg px-3 py-1.5 bg-transparent text-b-fg font-sans"
              >
                <option value="">Auto (system default)</option>
                {allowedModels.map((m) => (
                  <option key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`}>{m.label}</option>
                ))}
              </select>
            </div>
          )}
          {uploadState === 'idle' && (
            <button
              className="btn-primary self-start"
              onClick={() => {
                const [pp, ...mr] = modelPick ? modelPick.split(':') : []
                const pm = modelPick ? mr.join(':') : undefined
                void upload(blob, {
                  durationSeconds: elapsedSeconds,
                  startedAt: startedAtRef.current ?? new Date().toISOString(),
                  mimeType: mimeType ?? undefined,
                  folderId,
                  preferredProvider: pp || undefined,
                  preferredModel: pm || undefined,
                })
              }}
            >
              ↑ Save recording
            </button>
          )}

          {uploadState === 'uploading' && (
            <div className="flex items-center gap-3 rounded-2xl border border-b-primary/30 bg-b-clay px-4 py-3 self-start">
              <span
                className="inline-block w-5 h-5 shrink-0 rounded-full border-2 border-b-primary/25 border-t-b-primary animate-spin"
                aria-hidden="true"
              />
              <span className="text-sm text-b-fg/70 font-sans">Uploading… please wait</span>
            </div>
          )}

          {uploadState === 'error' && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-red-600 font-sans">{uploadError}</span>
              <button onClick={resetUpload} className="btn-secondary text-xs px-4 py-1.5">
                Retry
              </button>
            </div>
          )}

          {uploadState === 'done' && meetingId && (
            <div className="flex flex-col gap-4">
              <div className="bg-b-clay border border-b-primary/30 rounded-2xl px-4 py-3 text-sm text-b-fg font-sans">
                ✓ Saved! Your recording is now processing.
              </div>

              {/* Move the saved recording to a folder */}
              <FolderSelector
                value={folderId}
                onChange={(f) => { void handleMoveToFolder(f) }}
                disabled={moveBusy}
              />
              {moveError && <p className="text-xs text-red-500 font-sans">{moveError}</p>}

              {/* Actions — "Record another" lives in the Reset button above */}
              <div className="flex items-center gap-3 flex-wrap">
                <Link href={`/meetings/${meetingId}`} className="btn-primary">
                  View recording →
                </Link>
                <Link href="/meetings" className="text-sm text-b-terra font-semibold font-sans hover:underline">
                  All meetings
                </Link>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Debug info */}
      <details className="mt-2" open={state === 'error'}>
        <summary className="cursor-pointer text-xs text-b-fg/30 font-sans hover:text-b-fg/50">
          Debug info
        </summary>
        <pre className="mt-2 bg-b-clay rounded-xl p-3 text-xs overflow-auto leading-relaxed text-b-fg/60 font-mono">
          {JSON.stringify({ state, elapsedSeconds, trackInfo, mimeType, blobKB: blob ? +(blob.size / 1024).toFixed(1) : null }, null, 2)}
        </pre>
      </details>
    </div>
  )
}
