// Minimal layout for auth pages (login, register).
// No auth guard — these pages are intentionally accessible without a session.

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-b-bg flex items-center justify-center p-4 relative overflow-hidden">
      {/* Decorative background blobs */}
      <div
        className="pointer-events-none absolute -top-40 -right-40 w-96 h-96 rounded-full opacity-30"
        style={{ background: 'radial-gradient(circle, rgb(var(--t-secondary-rgb)) 0%, transparent 70%)' }}
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-32 -left-32 w-80 h-80 rounded-full opacity-20"
        style={{ background: 'radial-gradient(circle, rgb(var(--t-primary-rgb)) 0%, transparent 70%)' }}
        aria-hidden="true"
      />
      {children}
    </div>
  )
}
