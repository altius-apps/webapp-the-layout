// The live draft room (/fantasy/l/[contestId]/draft, not /draft/setup) is a
// fixed full-screen surface under the top rail, so the global chrome leaves out
// what would sit hidden behind it: the bottom nav and the site footer. Kept free
// of imports so the root-layout chrome can use it without pulling in Supabase.

const DRAFT_ROOM_PATH = /^\/fantasy\/l\/[^/]+\/draft\/?$/;

export function isDraftRoomPath(pathname: string): boolean {
  return DRAFT_ROOM_PATH.test(pathname);
}
