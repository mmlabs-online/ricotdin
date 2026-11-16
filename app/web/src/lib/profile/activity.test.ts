import { describe, expect, it } from 'vitest'
import { ACTIVITY_TYPES, activityKey, deviceLabel } from './activity'

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  operaWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0',
  chromeIpad: 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
}

describe('deviceLabel', () => {
  it('names the browser and the system', () => {
    expect(deviceLabel(UA.chromeMac)).toBe('Chrome · macOS')
    expect(deviceLabel(UA.edgeWin)).toBe('Edge · Windows')
    expect(deviceLabel(UA.safariIphone)).toBe('Safari · iOS')
    expect(deviceLabel(UA.firefoxLinux)).toBe('Firefox · Linux')
    expect(deviceLabel(UA.chromeAndroid)).toBe('Chrome · Android')
    expect(deviceLabel(UA.operaWin)).toBe('Opera · Windows')
    expect(deviceLabel(UA.chromeIpad)).toBe('Chrome · iPadOS')
  })
  it('keeps what it recognises, nothing for the rest', () => {
    expect(deviceLabel('curl/8.5.0')).toBeNull()
    expect(deviceLabel('testclient')).toBeNull()
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) SomethingNew/1.0')).toBe('Windows')
    expect(deviceLabel(null)).toBeNull()
    expect(deviceLabel('')).toBeNull()
  })
})

describe('activityKey', () => {
  it('one label per known event', () => {
    expect(activityKey('meeting_created', 'out', false)).toBe('profile.activity.events.meeting_created')
    expect(activityKey('chat_message', 'out', false)).toBe('profile.activity.events.chat_message')
  })
  it('a share reads from the caller’s side', () => {
    expect(activityKey('folder_shared', 'out', false)).toBe('profile.activity.events.folder_shared_out')
    expect(activityKey('folder_shared', 'in', false)).toBe('profile.activity.events.folder_shared_in')
    expect(activityKey('folder_unshared', 'out', false)).toBe('profile.activity.events.folder_removed_out')
    expect(activityKey('folder_unshared', 'in', false)).toBe('profile.activity.events.folder_removed_in')
    expect(activityKey('folder_unshared', 'out', true)).toBe('profile.activity.events.folder_left_out')
    expect(activityKey('folder_unshared', 'in', true)).toBe('profile.activity.events.folder_left_in')
  })
  it('anything else is “other”', () => {
    expect(activityKey('login', 'out', false)).toBe('profile.activity.events.other')
    expect(activityKey('__proto__', 'in', false)).toBe('profile.activity.events.other')
  })
  it('the filter offers every event the API accepts', () => {
    expect(ACTIVITY_TYPES).toEqual([
      'meeting_created', 'meeting_deleted', 'processing_done', 'processing_failed', 'record_start', 'record_stop',
      'recording_notice_ack', 'chat_message', 'folder_shared', 'folder_unshared',
    ])
  })
})
