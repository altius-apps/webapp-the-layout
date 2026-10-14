// League data is signed-in only (RLS, Hunter 2026-10-14: signed-out users
// don't see fantasy leagues). League reads go through the user's session: the
// browser client in the browser; on the server, the request's cookie client,
// which server.ts registers (it's server-only, so this shared module can't
// import it). Player/event reference data stays on the anon client.

import { createClient } from '@/lib/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

let serverReader: (() => AnyClient) | null = null;

export function registerServerReader(fn: () => AnyClient): void {
  serverReader = fn;
}

export function leagueReader(): AnyClient {
  if (typeof window !== 'undefined') return createClient() as unknown as AnyClient;
  if (!serverReader) {
    throw new Error('League data on the server needs @/lib/fantasy/server imported (it registers the session reader).');
  }
  return serverReader();
}
