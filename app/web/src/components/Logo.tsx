import { Sparkles } from 'lucide-react'

export function Logo({ size = 17 }: { size?: number }) {
  return (
    <div className="logo" aria-hidden="true">
      <Sparkles size={size} />
    </div>
  )
}
