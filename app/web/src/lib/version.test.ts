import { describe, expect, it } from 'vitest'
import { versionLabel } from './version'

describe('versionLabel (running release in the sidebar)', () => {
  it('shows a release tag with its v', () => {
    expect(versionLabel({ version: 'v2.2.3' })).toBe('v2.2.3')
    expect(versionLabel({ version: '2.2.3' })).toBe('v2.2.3')
    expect(versionLabel({ version: 'v2.3.0-rc1' })).toBe('v2.3.0-rc1')
  })

  it('shortens a build commit (no release tag set)', () => {
    expect(versionLabel({ version: '86426a6f0e1d2c3b4a59687766554433221100ff' })).toBe('86426a6')
  })

  it('shows nothing when the version is unknown or not what /version.json returns', () => {
    expect(versionLabel({ version: 'unknown' })).toBeNull()
    expect(versionLabel({ version: '' })).toBeNull()
    expect(versionLabel({ version: '<b>x</b>' })).toBeNull()
    expect(versionLabel({ version: 3 })).toBeNull()
    expect(versionLabel(null)).toBeNull()
    expect(versionLabel('v2.2.3')).toBeNull()
  })
})
