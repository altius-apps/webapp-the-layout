// moderateName for free text that may name real players: jersey listings and
// chat ("Should I draft Jason Dick?"). When the plain check fails, the server
// removes any run of words that exactly matches a real player in our data and
// the rest is checked again. The DB triggers do the same, so a user can't get
// an exemption just by claiming a name is a player. Over 2000 chars there is
// no exemption. User-chosen names (display, handle, fantasy or jersey team and
// league names) never get this: use moderateName directly.

import { createClient } from '@/lib/supabase/client';
import { moderateName } from '@/lib/moderation';

export async function moderateText(text: string, field: string): Promise<string | null> {
  const bad = moderateName(text, field);
  if (!bad) return null;
  const db = createClient() as any;
  const { data, error } = await db.rpc('mask_real_player_names', { p_text: text });
  // Can't verify the names: stay blocked (jersey callers never throw).
  if (error || typeof data !== 'string') return bad;
  return moderateName(data, field);
}
