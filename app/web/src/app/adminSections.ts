import { Activity, BarChart3, Gauge, HardDrive, Home, KeyRound, ShieldCheck, SlidersHorizontal, Users, type LucideIcon } from 'lucide-react'

export type AdminSection = { slug: string; key: string; icon: LucideIcon }

/** Sections of the Make admin design; `slug` '' is /admin itself. */
export const ADMIN_SECTIONS: AdminSection[] = [
  { slug: '', key: 'overview', icon: Home },
  { slug: 'users', key: 'users', icon: Users },
  { slug: 'pipeline', key: 'pipeline', icon: Activity },
  { slug: 'usage', key: 'usage', icon: BarChart3 },
  { slug: 'keys', key: 'keys', icon: KeyRound },
  { slug: 'storage', key: 'storage', icon: HardDrive },
  { slug: 'config', key: 'config', icon: SlidersHorizontal },
  { slug: 'activity', key: 'activity', icon: ShieldCheck },
  { slug: 'audit', key: 'audit', icon: ShieldCheck },
  { slug: 'features', key: 'features', icon: SlidersHorizontal },
  { slug: 'health', key: 'health', icon: Gauge },
  { slug: 'docs', key: 'docs', icon: ShieldCheck },
]
