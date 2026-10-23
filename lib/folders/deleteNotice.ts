// Copy for the folder delete confirm panels (BUG-014).
// Folder-scoped chat sessions are ON DELETE CASCADE for every user — by design,
// since grantees lose access to the owner's meetings in the folder anyway (BUG-013).

export function folderDeleteChatNotice(memberCount: number): string {
  const members = Number.isFinite(memberCount) ? Math.max(0, Math.floor(memberCount)) : 0
  if (members === 0) return 'Folder chat history will be deleted.'
  const noun = members === 1 ? 'member' : 'members'
  return `Folder chat history will be deleted for everyone, including any chats by its ${members} shared ${noun}.`
}
