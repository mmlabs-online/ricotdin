import type { Database } from '../types/database'

type Pub = Database['public']

// Does Pub.Views have the right shape?
type ViewsType = Pub['Views']
// This should show what 'meetings' insert looks like
type MeetingsRow = Pub['Tables']['meetings']['Row']
type MeetingsInsert = Pub['Tables']['meetings']['Insert']
type MeetingsRelationships = Pub['Tables']['meetings']['Relationships']

const _row: MeetingsRow = null as unknown as MeetingsRow
const _rel: MeetingsRelationships = []
export {}
