// Admin roles data layer — the user directory for the admin Roles tab.
//
// Reads through the admin_list_users() SECURITY DEFINER RPC, which is guarded
// (raises 'not authorized' for non-admins) and is the only place email from
// auth.users is exposed — admins only, never broadly. The /admin route is also
// gated server-side, so this is defense in depth.

import { createClient } from '@/lib/supabase/server';
import type { UserRole } from '@/lib/auth/types';

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string | null;
  username: string | null;
  role: UserRole;
  createdAt: string;
}

interface RawRow {
  id: string;
  email: string | null;
  display_name: string | null;
  username: string | null;
  role: string;
  created_at: string;
}

// The generated Database types don't include the admin_* RPCs (same as the
// utcg_* / twelve_oh_* helpers elsewhere). Cast to a minimal untyped rpc surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RpcResult = { data: any; error: { message: string } | null };
type RangedRpc = PromiseLike<RpcResult> & {
  order: (column: string, opts?: { ascending?: boolean }) => RangedRpc;
  range: (from: number, to: number) => RangedRpc;
};
type UntypedRpc = { rpc: (fn: string, args?: Record<string, unknown>) => RangedRpc };

const PAGE = 1000; // PostgREST's per-response row cap.

/** All users with their roles (newest first). Admin-only via the RPC guard. */
export async function getAllUsers(): Promise<AdminUserRow[]> {
  const supabase = createClient() as unknown as UntypedRpc;
  const rows: RawRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .rpc('admin_list_users')
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as RawRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows.map((r) => ({
    id: r.id,
    email: r.email ?? '(no email)',
    displayName: r.display_name,
    username: r.username,
    role: (r.role as UserRole) ?? 'user',
    createdAt: r.created_at,
  }));
}
