// Who may do what with a meeting in the UI (ARC-13a). Mirrors the v2 API (CLAUDE.md §0.6): pin,
// move and delete = the meeting owner; rename = owner or editor. The API enforces; this only
// hides controls that would fail. (v1's UI also let editors delete.)

export type MeetingRole = 'owner' | 'editor' | 'viewer'

export function getMeetingRole(
  meeting: { user_id: string; folder_id: string | null },
  currentUserId: string,
  folders: ReadonlyArray<{ id: string; myRole: MeetingRole }>,
): MeetingRole {
  if (meeting.user_id === currentUserId) return 'owner'
  if (!meeting.folder_id) return 'viewer'
  const role = folders.find((f) => f.id === meeting.folder_id)?.myRole
  // Someone else's meeting in my own folder: the API lets the folder owner rename it, but pin,
  // move and delete stay with the meeting owner — 'editor' gives exactly that in the UI.
  return role === 'editor' || role === 'owner' ? 'editor' : 'viewer'
}

export const canRename = (role: MeetingRole): boolean => role === 'owner' || role === 'editor'
export const canPin = (role: MeetingRole): boolean => role === 'owner'
export const canMove = (role: MeetingRole): boolean => role === 'owner'
export const canDelete = (role: MeetingRole): boolean => role === 'owner'

export function canManageShares(folder: { user_id: string }, currentUserId: string): boolean {
  return folder.user_id === currentUserId
}
