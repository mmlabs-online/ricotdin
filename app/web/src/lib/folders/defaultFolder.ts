// PRF-07: default folder for new meetings. Pure.
import type { Folder } from '../../api/meetings'

/** Folders a new meeting may go to: owned or shared with the user as editor (API rule). */
export function assignableFolders(folders: Folder[]): Folder[] {
  return folders.filter((f) => f.myRole === 'owner' || f.myRole === 'editor')
}

/** The Record page's starting choice: the default folder's id while it can still be used, '' for
 *  "no folder", undefined until both the preference and the folders are loaded. */
export function initialFolderChoice(
  defaultFolderId: string | null | undefined,
  folders: Folder[] | undefined,
): string | undefined {
  if (defaultFolderId === undefined || folders === undefined) return undefined
  if (defaultFolderId === null) return ''
  return assignableFolders(folders).some((f) => f.id === defaultFolderId) ? defaultFolderId : ''
}

/** Record page option "your default folder", used when the preference could not be loaded: the
 *  upload sends no folderId and the API applies the stored default. */
export const USE_DEFAULT = '__default__'

/** A saved default the user can no longer add meetings to (folder deleted, share revoked or
 *  downgraded). The API then creates meetings without a folder. */
export function defaultFolderLost(
  defaultFolderId: string | null | undefined,
  folders: Folder[] | undefined,
): boolean {
  if (!defaultFolderId || folders === undefined) return false
  return !assignableFolders(folders).some((f) => f.id === defaultFolderId)
}

/** The folderId the upload sends: undefined = not chosen (the API applies the default),
 *  null = "no folder". */
export function folderIdForUpload(choice: string | undefined): string | null | undefined {
  if (choice === undefined || choice === USE_DEFAULT) return undefined
  return choice === '' ? null : choice
}
