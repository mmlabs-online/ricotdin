// SERVER ONLY — shared-folder access helpers for API route handlers.
//
// Route handlers use the service-role Supabase client, which has no JWT context,
// so auth.uid() inside SQL functions returns null. These helpers perform the
// same access logic as the can_access_meeting() SQL function but accept an
// explicit userId argument.
//
// The SQL function (can_access_meeting) is the source of truth for RLS policies.
// These helpers must stay logically identical to it.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FolderRole } from '@/types/database'

/** Returns true if userId owns the folder or has a share row with role >= minRole. */
export async function checkFolderAccess(
  db: SupabaseClient,
  folderId: string,
  userId: string,
  minRole: 'viewer' | 'editor',
): Promise<boolean> {
  const { data: folder } = await db
    .from('folders')
    .select('user_id')
    .eq('id', folderId)
    .maybeSingle()

  if (!folder) return false
  if (folder.user_id === userId) return true  // folder owner

  const query = db
    .from('folder_shares')
    .select('role')
    .eq('folder_id', folderId)
    .eq('user_id', userId)

  const { data: share } = await query.maybeSingle()
  if (!share) return false
  if (minRole === 'viewer') return true  // editor and viewer both pass viewer check
  return share.role === 'editor'
}

/**
 * Returns true if userId can access the meeting at minRole level.
 * Mirrors the can_access_meeting() SQL function used in RLS policies.
 */
export async function checkMeetingAccess(
  db: SupabaseClient,
  meeting: { user_id: string; folder_id: string | null },
  userId: string,
  minRole: 'viewer' | 'editor',
): Promise<boolean> {
  if (meeting.user_id === userId) return true
  if (!meeting.folder_id) return false
  return checkFolderAccess(db, meeting.folder_id, userId, minRole)
}

/**
 * Returns the user's effective role for a meeting.
 * Used by UI helpers (see lib/access/roles.ts for the pure client-side variant).
 */
export async function getMeetingRole(
  db: SupabaseClient,
  meeting: { user_id: string; folder_id: string | null },
  userId: string,
): Promise<FolderRole> {
  if (meeting.user_id === userId) return 'owner'
  if (!meeting.folder_id) return 'viewer'

  const { data: folder } = await db
    .from('folders')
    .select('user_id')
    .eq('id', meeting.folder_id)
    .maybeSingle()

  if (!folder) return 'viewer'
  if (folder.user_id === userId) return 'owner'

  const { data: share } = await db
    .from('folder_shares')
    .select('role')
    .eq('folder_id', meeting.folder_id)
    .eq('user_id', userId)
    .maybeSingle()

  if (!share) return 'viewer'
  return share.role as 'editor' | 'viewer'
}

/**
 * Validates folder_id for a destination move: caller must own the folder
 * OR have editor access to it. Returns true if the assignment is allowed.
 */
export async function canAssignToFolder(
  db: SupabaseClient,
  folderId: string,
  userId: string,
): Promise<boolean> {
  return checkFolderAccess(db, folderId, userId, 'editor')
}
