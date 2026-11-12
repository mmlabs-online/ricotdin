'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import ChatPanel from '@/components/ChatPanel'
import type { Citation } from '@/types/database'

export default function ChatPage() {
  const router = useRouter()

  function handleCitationClick(citation: Citation) {
    void router.push(`/meetings/${citation.meeting_id}`)
  }

  return (
    <main className="max-w-[760px] mx-auto px-4 py-8 font-sans">
      <div className="mb-6">
        <Link
          href="/meetings"
          className="inline-block text-sm font-medium text-b-primary hover:opacity-80 transition-opacity mb-4"
        >
          ← Meetings
        </Link>
        <h1 className="font-serif text-2xl font-bold text-b-fg mb-2">
          Ask about your meetings
        </h1>
        <p className="text-sm text-b-fg/60 leading-relaxed">
          AI-powered Q&amp;A across all your processed meeting transcripts.
          Click a timestamp chip to jump to that meeting.
        </p>
      </div>

      <div className="card-botanical p-5">
        <ChatPanel
          meetingId={null}
          onCitationClick={handleCitationClick}
        />
      </div>
    </main>
  )
}
