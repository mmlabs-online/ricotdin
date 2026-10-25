'use client'

import dynamic from 'next/dynamic'

const RedocStandalone = dynamic(
  () => import('redoc').then((m) => ({ default: m.RedocStandalone })),
  { ssr: false, loading: () => <p style={S.loading}>Loading API docs…</p> }
)

export default function DocsPage() {
  return (
    <div style={S.wrap}>
      <RedocStandalone
        specUrl="/api/openapi"
        options={{
          hideDownloadButton: false,
          hideHostname: false,
          pathInMiddlePanel: false,
          nativeScrollbars: false,
          theme: {
            colors: { primary: { main: '#3b82f6' } },
            sidebar: { width: '260px', backgroundColor: '#0f172a', textColor: '#94a3b8' },
            rightPanel: { backgroundColor: '#1e293b' },
            typography: { fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: '14px' },
          },
        }}
      />
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', background: '#fff' },
  loading: { padding: 32, color: '#888', fontFamily: 'system-ui, sans-serif' },
}
