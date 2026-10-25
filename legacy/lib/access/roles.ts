// Pure helpers for determining meeting/folder roles in the UI.
// No I/O — safe to import on the client side and to test directly.

import type { FolderRole, FolderWithRole } from '@/types/database'

export function getMeetingRole(
  meeting: { user_id: string; folder_id: string | null },
  currentUserId: string,
  folders: FolderWithRole[],
): FolderRole {
  if (meeting.user_id === currentUserId) return 'owner'
  if (!meeting.folder_id) return 'viewer'
  const folder = folders.find((f) => f.id === meeting.folder_id)
  return folder?.myRole ?? 'viewer'
}

export function canPin(meeting: { user_id: string }, currentUserId: string): boolean {
  return meeting.user_id === currentUserId
}

export function canEdit(role: FolderRole): boolean {
  return role === 'owner' || role === 'editor'
}

export function canDelete(role: FolderRole): boolean {
  return role === 'owner' || role === 'editor'
}

export function canManageShares(folder: { user_id: string }, currentUserId: string): boolean {
  return folder.user_id === currentUserId
}
