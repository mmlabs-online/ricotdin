// Folder delete confirm panel helpers (BUG-014..016, ported for ARC-13a; the text is in i18n).
// Folder-scoped chat sessions are ON DELETE CASCADE for every user — by design,
// since grantees lose access to the owner's meetings in the folder anyway (BUG-013).

export function folderDeleteChatNotice(memberCount: number): { key: string; count: number } {
  const count = Number.isFinite(memberCount) ? Math.max(0, Math.floor(memberCount)) : 0
  return { key: count === 0 ? 'folders.delete.chatNotice' : 'folders.delete.chatNoticeShared', count }
}

// Meeting counts for the folder delete confirm panel (BUG-015).
// `DELETE /api/folders/:id?deleteMeetings=true` deletes only the caller's own meetings
// in the folder (BUG-011); other users' meetings move to their own Uncategorized.
// Pinned meetings are in the folder too and must be counted.
export function folderDeleteCounts(
  meetings: { user_id: string; folder_id: string | null }[],
  folderId: string,
  callerId: string,
): { total: number; deletable: number; othersMoved: number } {
  const inFolder = meetings.filter((m) => m.folder_id === folderId)
  // Caller not known yet (user still loading): claim nothing about ownership.
  if (!callerId) return { total: inFolder.length, deletable: 0, othersMoved: 0 }
  const deletable = inFolder.filter((m) => m.user_id === callerId).length
  return { total: inFolder.length, deletable, othersMoved: inFolder.length - deletable }
}

// Local meeting list after a successful folder delete (BUG-016).
// Delete path: every meeting of the folder leaves the list (the caller's are deleted; the
// caller loses access to the others). Keep path: the caller's meetings move to Uncategorized;
// other users' meetings go to *their* Uncategorized, which the caller can no longer see.
// Unknown caller: fall back to moving every folder meeting to Uncategorized.
export function meetingsAfterFolderDelete<T extends { user_id: string; folder_id: string | null }>(
  meetings: T[],
  folderId: string,
  callerId: string,
  deleteMeetings: boolean,
): T[] {
  if (deleteMeetings) return meetings.filter((m) => m.folder_id !== folderId)
  return meetings
    .filter((m) => m.folder_id !== folderId || !callerId || m.user_id === callerId)
    .map((m) => (m.folder_id === folderId ? { ...m, folder_id: null } : m))
}
