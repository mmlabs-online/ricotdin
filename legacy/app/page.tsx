'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  Mic,
  FileText,
  Brain,
  CheckSquare,
  Calendar,
  MessageSquare,
  Shield,
  ChevronDown,
  ArrowRight,
  Clock,
  Lock,
  Menu,
  X,
  Sparkles,
  Database,
  Eye,
  Users,
  Trash2,
} from 'lucide-react'

// ─── Hero Mockup ──────────────────────────────────────────────────────────────

function HeroMockup() {
  return (
    <div className="relative w-full max-w-xl mx-auto select-none" aria-hidden="true">
      {/* Background glow */}
      <div className="absolute -inset-8 bg-gradient-to-br from-b-terra/10 to-b-primary/8 rounded-[3rem] blur-3xl -z-10" />

      {/* Main transcript card — dark style */}
      <div className="bg-[#1a1f1c] rounded-2xl border border-white/8 shadow-2xl p-5">
        {/* Recording bar */}
        <div className="flex items-center justify-between mb-4 pb-3.5 border-b border-white/8">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            <span className="text-[10px] font-mono text-white/35 uppercase tracking-widest">
              Recording · 24:18
            </span>
          </div>
          <span className="px-2.5 py-0.5 rounded-full bg-b-terra/20 text-b-terra text-[9px] font-bold uppercase tracking-wider">
            Live
          </span>
        </div>

        {/* Transcript lines */}
        <div className="space-y-3.5">
          {[
            {
              time: '00:15',
              initial: 'S',
              speaker: 'Sarah',
              text: "Let's kick off the Q3 review. Revenue is up 23% YoY.",
              color: 'bg-b-terra/25 text-b-terra',
            },
            {
              time: '00:22',
              initial: 'M',
              speaker: 'Mike',
              text: 'Revenue is up 23% YoY — strongest quarter yet.',
              color: 'bg-b-primary/25 text-b-primary',
            },
            {
              time: '00:31',
              initial: 'S',
              speaker: 'Sarah',
              text: 'About Q4 budget — we need a final decision today.',
              color: 'bg-b-terra/25 text-b-terra',
            },
            {
              time: '00:47',
              initial: 'M',
              speaker: 'Mike',
              text: "I'd propose a 15% increase — it covers two engineering hires.",
              color: 'bg-b-primary/25 text-b-primary',
            },
          ].map((line) => (
            <div key={line.time} className="flex items-start gap-2.5 group">
              <span className="text-[10px] font-mono text-white/25 pt-0.5 w-8 flex-shrink-0 group-hover:text-b-terra transition-colors duration-200 cursor-pointer">
                {line.time}
              </span>
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 mt-0.5 ${line.color}`}
              >
                {line.initial}
              </span>
              <span className="text-[11px] text-white/65 leading-relaxed">{line.text}</span>
            </div>
          ))}
        </div>

        {/* Auto-extracted footer */}
        <div className="mt-4 pt-3.5 border-t border-white/8">
          <p className="text-[9px] font-mono uppercase tracking-widest text-white/25 mb-2">
            Auto-extracted · 2 items
          </p>
          <div className="flex flex-wrap gap-1.5">
            <span className="px-2.5 py-1 rounded-full bg-green-900/50 text-green-400 border border-green-700/40 text-[10px] font-semibold">
              ✓ Approve Q4 budget · Mike
            </span>
            <span className="px-2.5 py-1 rounded-full bg-amber-900/40 text-amber-400 border border-amber-700/40 text-[10px] font-semibold">
              📅 Hiring call · Thu
            </span>
          </div>
        </div>
      </div>

      {/* Floating chat card */}
      <div className="absolute -right-4 sm:-right-6 bottom-4 sm:bottom-6 w-52 sm:w-60 bg-b-bg rounded-2xl border border-b-border shadow-b-xl p-4 z-20">
        <div className="flex items-center gap-1.5 mb-3">
          <MessageSquare size={10} className="text-b-primary" />
          <span className="text-[9px] font-sans font-semibold uppercase tracking-widest text-b-fg/40">
            Meeting chatbot
          </span>
        </div>

        {/* User message */}
        <div className="bg-b-terra rounded-xl rounded-br-sm px-3 py-2 text-[11px] mb-2 ml-6 leading-relaxed">
          <p className="text-white">What was the Q4 budget decision?</p>
        </div>

        {/* AI response */}
        <div className="bg-b-clay rounded-xl rounded-bl-sm px-3 py-2 text-[11px] mr-5">
          <p className="text-b-fg/80 leading-relaxed mb-2">
            The team approved a <strong>15% budget increase</strong> for Q4, primarily
            to fund two additional engineering hires.
          </p>
          <div className="flex items-center gap-1 text-b-terra text-[10px] font-semibold cursor-pointer hover:underline">
            <span>↗</span>
            <span>00:47 · Mike</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Section Label ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block px-3 py-1 rounded-full border border-b-border text-[11px] font-sans font-semibold uppercase tracking-widest text-b-fg/50">
      {children}
    </span>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 24)
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])

  const navLinks = [
    { href: '#features', label: 'Features' },
    { href: '#how-it-works', label: 'How it works' },
    { href: '#security', label: 'Security' },
  ]

  const features = [
    {
      icon: <Mic size={18} />,
      title: 'Browser-based recording',
      desc: 'Capture system audio, tab audio, and mic — all mixed in your browser. No install, no plugin, no invited bot.',
    },
    {
      icon: <Clock size={18} />,
      title: 'Timestamped transcript',
      desc: 'Full speaker-labelled transcript with clickable timestamps. Jump to any moment in the recording instantly.',
    },
    {
      icon: <FileText size={18} />,
      title: 'Summary & meeting notes',
      desc: 'Structured summary and rich meeting notes generated automatically — ready to copy, share, or file away.',
    },
    {
      icon: <CheckSquare size={18} />,
      title: 'To-do extraction',
      desc: 'Action items with owner names and deadlines pulled directly from the conversation — no manual markup.',
    },
    {
      icon: <Calendar size={18} />,
      title: 'Calendar mentions & .ics',
      desc: 'Dates and events mentioned in the meeting exported as a standard .ics file for any calendar app.',
    },
    {
      icon: <MessageSquare size={18} />,
      title: 'Meeting management',
      desc: 'Pin, rename, search, and delete your meeting library. Everything you need to stay organised.',
    },
  ]

  const privacyPoints = [
    {
      icon: <Eye size={20} />,
      title: 'Audio only — never video',
      desc: 'We capture audio exclusively. No screen capture, no video stream is ever recorded or stored.',
    },
    {
      icon: <Lock size={20} />,
      title: 'Private storage by design',
      desc: 'Files are served via signed URLs. Your recordings are never publicly accessible.',
    },
    {
      icon: <Database size={20} />,
      title: 'Never used for AI training',
      desc: 'Your meeting content is never used to train any AI model. Your data is yours, full stop.',
    },
    {
      icon: <Trash2 size={20} />,
      title: 'You control deletion',
      desc: 'Delete a meeting and everything — audio, transcript, notes, embeddings — is permanently gone.',
    },
  ]

  return (
    <div className="min-h-screen bg-b-bg text-b-fg font-sans">

      {/* ─── Navigation ────────────────────────────────────────────────────── */}
      <header
        className={`sticky top-0 z-50 transition-all duration-300 ${
          scrolled
            ? 'bg-b-bg/95 backdrop-blur-md border-b border-b-border shadow-b-sm'
            : 'bg-transparent border-b border-transparent'
        }`}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          {/* Logo */}
          <Link href="/" className="flex items-center" aria-label="Ricotdin home">
            <img
              src="/short-logo.png"
              alt="Ricotdin"
              style={{ height: '36px', width: 'auto' }}
            />
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map(({ href, label }) => (
              <a
                key={href}
                href={href}
                className="px-3 py-1.5 rounded-full text-sm font-medium text-b-fg/60 hover:text-b-fg hover:bg-b-clay transition-all duration-200"
              >
                {label}
              </a>
            ))}
          </nav>

          {/* CTA buttons */}
          <div className="hidden md:flex items-center gap-2">
            <Link
              href="/login"
              className="px-4 py-2 text-sm font-medium text-b-fg/65 hover:text-b-fg transition-colors duration-200"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="btn-primary text-sm px-5 py-2"
            >
              Try it free
            </Link>
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label="Toggle navigation menu"
            className="md:hidden p-2 rounded-xl border border-b-border text-b-fg/60 hover:text-b-fg cursor-pointer bg-transparent transition-colors"
          >
            {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-b-border bg-b-bg px-4 py-4 flex flex-col gap-1.5">
            {navLinks.map(({ href, label }) => (
              <a
                key={href}
                href={href}
                onClick={() => setMobileMenuOpen(false)}
                className="px-4 py-2.5 rounded-xl text-sm font-medium text-b-fg/70 hover:bg-b-clay hover:text-b-fg transition-all"
              >
                {label}
              </a>
            ))}
            <div className="border-t border-b-border pt-3 mt-1 flex flex-col gap-2">
              <Link
                href="/login"
                className="btn-secondary text-center text-sm"
                onClick={() => setMobileMenuOpen(false)}
              >
                Sign in
              </Link>
              <Link
                href="/register"
                className="btn-primary text-center text-sm"
                onClick={() => setMobileMenuOpen(false)}
              >
                Try it free
              </Link>
            </div>
          </div>
        )}
      </header>

      {/* ─── Hero ──────────────────────────────────────────────────────────── */}
      <section id="hero" className="relative overflow-hidden py-20 md:py-28 lg:py-36">
        {/* Decorative radials */}
        <div
          className="absolute top-0 right-0 w-[700px] h-[700px] -translate-y-1/2 translate-x-1/3 pointer-events-none rounded-full opacity-40"
          style={{ background: 'radial-gradient(circle, rgb(var(--t-terra-rgb) / 0.12) 0%, transparent 65%)' }}
          aria-hidden="true"
        />
        <div
          className="absolute bottom-0 left-0 w-[500px] h-[500px] translate-y-1/2 -translate-x-1/3 pointer-events-none rounded-full opacity-40"
          style={{ background: 'radial-gradient(circle, rgb(var(--t-primary-rgb) / 0.12) 0%, transparent 65%)' }}
          aria-hidden="true"
        />

        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">

            {/* Text content */}
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-b-terra/10 border border-b-terra/20 mb-6">
                <Sparkles size={11} className="text-b-terra" aria-hidden="true" />
                <span className="text-[11px] font-semibold text-b-terra uppercase tracking-widest">
                  No bot · No video · Full record
                </span>
              </div>

              <h1 className="font-serif text-4xl sm:text-5xl lg:text-[3.4rem] font-bold text-b-fg leading-[1.1] tracking-tight mb-6">
                Stop taking notes.{' '}
                <em className="italic text-b-terra">Start being present.</em>
              </h1>

              <p className="text-base sm:text-lg text-b-fg/65 leading-relaxed mb-8 max-w-lg">
                Ricotdin records and transcribes every word directly in your browser — no
                install, no bot crashing your call. When it&apos;s over, your summary,
                action items, and a searchable transcript are waiting.
              </p>

              <div className="flex flex-col sm:flex-row gap-3 mb-4">
                <Link
                  href="/register"
                  className="btn-primary text-base px-7 py-3 flex items-center justify-center gap-2"
                >
                  Try it free
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
                <a
                  href="#how-it-works"
                  className="btn-secondary text-base px-7 py-3 flex items-center justify-center gap-2"
                >
                  See how it works
                </a>
              </div>

              <p className="text-xs text-b-fg/38 font-sans">
                No credit card required · Works in Any Browsers
              </p>
            </div>

            {/* Illustration */}
            <HeroMockup />
          </div>
        </div>
      </section>

      {/* ─── Platform Strip ─────────────────────────────────────────────────── */}
      <div className="border-y border-b-border bg-b-clay/25">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-7">
          <p className="text-center text-[10px] uppercase tracking-widest font-semibold text-b-fg/35 mb-5">
            Works alongside any meeting platform
          </p>
          <div className="flex flex-wrap justify-center gap-5 sm:gap-10 items-center">
            {[
              { name: 'Google Meet', abbr: 'G', color: '#1a73e8' },
              { name: 'Microsoft Teams', abbr: 'T', color: '#5e50e6' },
              { name: 'Zoom', abbr: 'Z', color: '#2d8cff' },
              { name: 'Any Browsers', abbr: '◎', color: '#8C9A84' },
            ].map(({ name, abbr, color }) => (
              <div
                key={name}
                className="flex items-center gap-2.5 text-sm font-sans font-medium text-b-fg/55"
              >
                <span
                  className="w-8 h-8 rounded-xl flex items-center justify-center text-sm font-bold bg-b-bg border border-b-border"
                  style={{ color }}
                  aria-hidden="true"
                >
                  {abbr}
                </span>
                <span>{name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Problem ────────────────────────────────────────────────────────── */}
      <section className="py-20 md:py-28">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 text-center">
          <SectionLabel>The problem</SectionLabel>
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-b-fg mt-4 mb-4 leading-tight">
            You can&apos;t take notes and be fully present.
          </h2>
          <p className="text-b-fg/55 max-w-lg mx-auto text-base leading-relaxed mb-14">
            Split attention is the hidden tax of every meeting. Something always slips through.
          </p>

          <div className="grid sm:grid-cols-3 gap-5">
            {[
              {
                emoji: '✏️',
                title: 'Half your focus goes to typing',
                desc: "Every second you spend writing is a second you're not listening. You miss tone, subtext, and the half-sentence that changes everything.",
              },
              {
                emoji: '📋',
                title: 'Action items evaporate',
                desc: '"Who was supposed to handle that?" Your notes say "Mike — pricing" but Mike doesn\'t remember the deadline, and neither do you.',
              },
              {
                emoji: '🔍',
                title: 'Decisions become myths',
                desc: 'Two weeks later nobody agrees on what was decided. Everyone has a different note. The meeting might as well not have happened.',
              },
            ].map(({ emoji, title, desc }) => (
              <div key={title} className="card-botanical p-6 text-left">
                <div className="text-3xl mb-4" aria-hidden="true">
                  {emoji}
                </div>
                <h3 className="font-serif font-bold text-b-fg text-lg mb-2 leading-snug">{title}</h3>
                <p className="text-sm text-b-fg/60 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── How it works ───────────────────────────────────────────────────── */}
      <section id="how-it-works" className="py-20 md:py-28 bg-b-clay/20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
          <SectionLabel>How it works</SectionLabel>
          <h2 className="font-serif text-3xl sm:text-4xl font-bold text-b-fg mt-4 mb-3">
            Three steps. That&apos;s it.
          </h2>
          <p className="text-b-fg/55 max-w-sm mx-auto text-base mb-16">
            No configuration, no bot to authorise, nothing to install.
          </p>

          <div className="grid sm:grid-cols-3 gap-8 relative">
            {/* Connector line */}
            <div
              className="hidden sm:block absolute top-10 left-[22%] right-[22%] h-px"
              style={{
                background: 'linear-gradient(to right, transparent, rgb(var(--t-border-rgb)), transparent)',
              }}
              aria-hidden="true"
            />

            {[
              {
                step: '01',
                icon: <Mic size={22} aria-hidden="true" />,
                title: 'Open the app',
                desc: "Navigate to Ricotdin and hit Record. Allow audio capture — that's the only permission needed.",
              },
              {
                step: '02',
                icon: <Users size={22} aria-hidden="true" />,
                title: 'Meet as usual',
                desc: 'Join your Google Meet, Zoom, or Teams call. Talk, present, brainstorm — exactly as you normally would.',
              },
              {
                step: '03',
                icon: <Brain size={22} aria-hidden="true" />,
                title: 'Get everything',
                desc: 'Stop recording and your transcript, summary, to-dos, and calendar items are ready within minutes.',
              },
            ].map(({ step, icon, title, desc }) => (
              <div key={step} className="flex flex-col items-center text-center relative">
                <div className="w-20 h-20 rounded-3xl bg-b-bg border-2 border-b-border flex items-center justify-center text-b-terra mb-5 shadow-b-sm relative z-10">
                  {icon}
                </div>
                <div className="text-[10px] font-mono text-b-fg/28 font-semibold uppercase tracking-widest mb-1.5">
                  {step}
                </div>
                <h3 className="font-serif font-bold text-b-fg text-xl mb-2">{title}</h3>
                <p className="text-sm text-b-fg/55 leading-relaxed max-w-[200px]">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Features ───────────────────────────────────────────────────────── */}
      <section id="features" className="py-20 md:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-14">
            <SectionLabel>Features</SectionLabel>
            <h2 className="font-serif text-3xl sm:text-4xl font-bold text-b-fg mt-4 mb-4">
              Everything you wish your notes could be
            </h2>
            <p className="text-b-fg/55 max-w-lg mx-auto text-base">
              Built around one idea: your attention belongs in the conversation, not split
              between talking and typing.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map(({ icon, title, desc }) => (
              <div
                key={title}
                className="card-botanical p-6 group hover:shadow-b-xl transition-all duration-300"
              >
                <div className="w-9 h-9 rounded-2xl bg-b-terra/10 flex items-center justify-center text-b-terra mb-4 group-hover:scale-110 transition-transform duration-300">
                  {icon}
                </div>
                <h3 className="font-serif font-bold text-b-fg text-lg mb-2 leading-snug">{title}</h3>
                <p className="text-sm text-b-fg/60 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── RAG Chatbot Spotlight ──────────────────────────────────────────── */}
      <section className="py-20 md:py-28 bg-b-fg text-white relative overflow-hidden">
        {/* Subtle noise texture */}
        <div
          className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            backgroundRepeat: 'repeat',
          }}
          aria-hidden="true"
        />

        <div className="max-w-6xl mx-auto px-4 sm:px-6 relative z-10">
          <div className="grid lg:grid-cols-2 gap-14 items-center">

            {/* Text */}
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-white/15 mb-6">
                <MessageSquare size={11} className="text-b-terra" aria-hidden="true" />
                <span className="text-[11px] font-semibold uppercase tracking-widest text-b-terra/90">
                  RAG chatbot · with citations
                </span>
              </div>

              <h2 className="font-serif text-3xl sm:text-4xl font-bold leading-tight mb-5">
                Ask anything about{' '}
                <em className="italic text-b-terra">any meeting you&apos;ve ever had.</em>
              </h2>

              <p className="text-white/60 text-base leading-relaxed mb-7">
                The chatbot searches across all your meetings and gives grounded, cited
                answers. Every claim links to the exact speaker and timestamp. If the answer
                isn&apos;t in the transcript, it says so — it never invents.
              </p>

              <ul className="space-y-3">
                {[
                  'Ask about one meeting or all of them at once',
                  'Citations link to the exact timestamp — click to jump',
                  'Never hallucinates: "not found" beats a plausible lie',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm text-white/70">
                    <span className="w-5 h-5 rounded-full bg-b-terra/22 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <ArrowRight size={10} className="text-b-terra" aria-hidden="true" />
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Chat UI */}
            <div className="bg-white/[0.05] backdrop-blur-sm rounded-3xl border border-white/10 p-6">
              <div className="flex items-center gap-2 mb-5 pb-4 border-b border-white/10">
                <span className="w-2 h-2 rounded-full bg-b-terra animate-pulse" aria-hidden="true" />
                <span className="text-[10px] font-sans font-semibold uppercase tracking-widest text-white/38">
                  Meeting chatbot
                </span>
              </div>

              <div className="space-y-4">
                {/* Q1 */}
                <div className="flex justify-end">
                  <div className="bg-b-terra/75 rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[80%]">
                    <p className="text-sm text-white leading-relaxed">
                      What was the Q4 budget decision?
                    </p>
                  </div>
                </div>

                {/* A1 with citations */}
                <div className="flex items-start gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-b-terra/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Brain size={13} className="text-b-terra" aria-hidden="true" />
                  </div>
                  <div className="bg-white/8 rounded-2xl rounded-bl-sm px-4 py-3 max-w-[85%]">
                    <p className="text-sm text-white/82 leading-relaxed mb-2.5">
                      The team approved a{' '}
                      <strong className="text-white">15% budget increase</strong> for Q4,
                      primarily to fund two additional engineering hires.
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-b-terra/22 text-b-terra text-[10px] font-semibold cursor-pointer hover:bg-b-terra/38 transition-colors">
                        ↗ 00:47 · Mike
                      </span>
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-b-terra/22 text-b-terra text-[10px] font-semibold cursor-pointer hover:bg-b-terra/38 transition-colors">
                        ↗ 01:03 · Sarah
                      </span>
                    </div>
                  </div>
                </div>

                {/* Q2 */}
                <div className="flex justify-end">
                  <div className="bg-b-terra/75 rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[80%]">
                    <p className="text-sm text-white leading-relaxed">
                      What did we say about the mobile app?
                    </p>
                  </div>
                </div>

                {/* A2 — honest not found */}
                <div className="flex items-start gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-b-terra/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Brain size={13} className="text-b-terra" aria-hidden="true" />
                  </div>
                  <div className="bg-white/8 rounded-2xl rounded-bl-sm px-4 py-3 max-w-[85%]">
                    <p className="text-sm text-white/52 leading-relaxed italic">
                      The mobile app wasn&apos;t mentioned in this meeting. Try searching
                      across all your meetings — it may have come up in a different call.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Security & Privacy ─────────────────────────────────────────────── */}
      <section id="security" className="py-20 md:py-28">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-14">
            <SectionLabel>Security & Privacy</SectionLabel>
            <h2 className="font-serif text-3xl sm:text-4xl font-bold text-b-fg mt-4 mb-4">
              Your meetings are sensitive. We treat them that way.
            </h2>
            <p className="text-b-fg/55 max-w-xl mx-auto text-base leading-relaxed">
              We&apos;re not an enterprise compliance vendor — we&apos;re a tool built for
              people who care about what happens to their data.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-5 mb-6">
            {privacyPoints.map(({ icon, title, desc }) => (
              <div key={title} className="card-botanical p-6 flex gap-4">
                <div className="w-10 h-10 rounded-2xl bg-b-primary/10 flex items-center justify-center text-b-primary flex-shrink-0 mt-0.5">
                  {icon}
                </div>
                <div>
                  <h3 className="font-serif font-bold text-b-fg text-lg mb-1.5 leading-snug">{title}</h3>
                  <p className="text-sm text-b-fg/60 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Trust bar */}
          <div className="p-5 rounded-2xl bg-b-clay/40 border border-b-border flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <Shield size={22} className="text-b-primary flex-shrink-0" aria-hidden="true" />
            <p className="text-sm text-b-fg/65 leading-relaxed">
              <strong className="text-b-fg">API keys never reach the browser.</strong> All
              AI processing happens server-side. No secret is ever exposed to the client,
              and nothing sensitive is ever logged.
            </p>
          </div>
        </div>
      </section>

      {/* ─── Final CTA ──────────────────────────────────────────────────────── */}
      <section className="py-24 md:py-32 relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse 80% 60% at 50% 50%, rgb(var(--t-terra-rgb) / 0.07) 0%, transparent 70%)',
          }}
          aria-hidden="true"
        />
        <div
          className="absolute top-0 left-0 w-full h-px"
          style={{
            background: 'linear-gradient(to right, transparent, rgb(var(--t-border-rgb)), transparent)',
          }}
          aria-hidden="true"
        />

        <div className="max-w-2xl mx-auto px-4 sm:px-6 text-center relative z-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-b-terra/10 border border-b-terra/20 mb-6">
            <Sparkles size={11} className="text-b-terra" aria-hidden="true" />
            <span className="text-[11px] font-semibold text-b-terra uppercase tracking-widest">
              Free to try
            </span>
          </div>

          <h2 className="font-serif text-4xl sm:text-5xl font-bold text-b-fg leading-tight mb-5">
            Reclaim your attention.{' '}
            <em className="italic text-b-terra">Never miss a detail again.</em>
          </h2>

          <p className="text-b-fg/55 text-base sm:text-lg leading-relaxed mb-10 max-w-xl mx-auto">
            Get your first meeting recorded, transcribed, and summarised in minutes. No
            credit card, no install, no bot.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/register"
              className="btn-primary text-base px-8 py-3.5 flex items-center justify-center gap-2"
            >
              Get started for free
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <Link
              href="/login"
              className="btn-secondary text-base px-8 py-3.5 flex items-center justify-center"
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* ─── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="border-t border-b-border bg-b-clay/20 py-12">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="flex flex-col sm:flex-row items-start justify-between gap-10">
            {/* Brand */}
            <div className="max-w-xs">
              <Link href="/" aria-label="Ricotdin home" className="inline-block mb-2">
                <img
                  src="/short-logo.png"
                  alt="Ricotdin"
                  style={{ height: '32px', width: 'auto' }}
                />
              </Link>
              <p className="text-xs text-b-fg/40 leading-relaxed">
                Record, transcribe, and query your meetings — privately, in your browser.
              </p>
            </div>

            {/* Links */}
            <div className="flex gap-10 sm:gap-14">
              {[
                {
                  group: 'Product',
                  links: [
                    { label: 'Features', href: '#features' },
                    { label: 'How it works', href: '#how-it-works' },
                    { label: 'Security', href: '#security' },
                  ],
                },
                {
                  group: 'Legal',
                  links: [
                    { label: 'Terms', href: '#' },
                    { label: 'Privacy', href: '#' },
                    { label: 'Contact', href: '#' },
                  ],
                },
              ].map(({ group, links }) => (
                <div key={group}>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-b-fg/35 mb-3">
                    {group}
                  </div>
                  <ul className="space-y-2">
                    {links.map(({ label, href }) => (
                      <li key={label}>
                        <a
                          href={href}
                          className="text-sm text-b-fg/55 hover:text-b-fg transition-colors duration-200"
                        >
                          {label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-b-border mt-10 pt-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-b-fg/28">
            <span>© 2024 Ricotdin. All rights reserved.</span>
            <span>Made by MingMing</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
