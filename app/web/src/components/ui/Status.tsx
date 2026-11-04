import type { ReactNode } from 'react'

export function Status({ type, children }: { type: 'success' | 'processing' | 'danger'; children: ReactNode }) {
  return (
    <span className={`status status-${type}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  )
}
