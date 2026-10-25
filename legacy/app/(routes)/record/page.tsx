'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import RecorderUI from '@/components/RecorderUI'

function RecorderLoading() {
  return (
    <div className="card-botanical text-center py-10 text-sm text-b-fg/40 font-sans animate-pulse">
      Loading recorder…
    </div>
  )
}

function RecordContent() {
  // If the user came from a folder view (/record?folder=<id>), pre-select that
  // folder so the recording / uploaded file lands there by default.
  const searchParams = useSearchParams()
  const initialFolderId = searchParams.get('folder')

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return mounted ? <RecorderUI initialFolderId={initialFolderId} /> : <RecorderLoading />
}

export default function RecordPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8 text-center">
        <h1 className="font-serif text-4xl font-bold text-b-fg leading-tight mb-2">
          New <em className="italic text-b-terra">Recording</em>
        </h1>
        <p className="text-sm text-b-fg/50 font-sans leading-relaxed max-w-md mx-auto">
          Chrome &amp; Edge only · captures mic + tab audio · video is{' '}
          <span className="font-semibold text-b-fg/60">never recorded or saved</span>
        </p>
      </div>

      <Suspense fallback={<RecorderLoading />}>
        <RecordContent />
      </Suspense>
    </div>
  )
}
