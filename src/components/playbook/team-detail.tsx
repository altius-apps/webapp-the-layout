'use client';

// /playbook/teams/[id] — the people/admin side of one team (ported from
// mobile, Hunter 2026-09-09). Roster + lines live on the Team landing page;
// this page is:
//   MEMBERS — every login on the team, owner first, then coaches, members.
//   PENDING INVITES (owner / coach) — email / role / expiry, Resend + Revoke.
//   SEND INVITE (owner / coach) — email + role → the shared invite-email Edge
//     Function creates the invite and emails it; if the email fails, the share
//     link is shown (and copied) so the invite stays usable.
//   OWNER — Rename, Delete (confirm → back to /playbook/teams).
//   NON-OWNER — Leave (confirm → back).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PlaybookShell } from './playbook-shell';
import { TeamBadge } from './manage-teams';
import { AlertDialog, ConfirmDialog, PromptDialog } from '@/components/confirm-dialog';
import {
  deleteTeam,
  getPendingInviteToken,
  leaveTeam,
  listMyTeams,
  listPendingInvites,
  listTeamMembers,
  renameTeam,
  revokeInvite,
  sendTeamInvite,
  type PendingInvite,
  type Team,
  type TeamMember,
  type TeamRole,
} from '@/lib/playbook/data';
import { formatSupabaseError } from '@/lib/supabase/errors';

const ROLE_ORDER: Record<TeamRole, number> = { owner: 0, coach: 1, member: 2 };

function formatExpiry(expiresAt: number): string {
  const days = Math.max(0, Math.ceil((expiresAt * 1000 - Date.now()) / 86400_000));
  return days === 0 ? 'expires today' : `${days}d left`;
}

export function TeamDetail({ teamID }: { teamID: string }) {
  const router = useRouter();
  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendingInviteID, setResendingInviteID] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; body?: React.ReactNode } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [pendingAction, setPendingAction] = useState<'delete' | 'leave' | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const team = teams.find((t) => t.id === teamID) ?? null;
  const canManage = team?.role === 'owner' || team?.role === 'coach';
  const isOwner = team?.role === 'owner';

  const refresh = useCallback(async () => {
    try {
      const t = await listMyTeams();
      setTeams(t);
      const me = t.find((tm) => tm.id === teamID);
      if (!me) {
        setMembers(null);
        return;
      }
      const editor = me.role === 'owner' || me.role === 'coach';
      const [m, inv] = await Promise.all([
        listTeamMembers(teamID),
        editor ? listPendingInvites(teamID) : Promise.resolve([]),
      ]);
      setMembers([...m].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.joinedAt - b.joinedAt));
      setInvites(inv);
    } catch (err) {
      setError(formatSupabaseError(err, 'Load team'));
      console.error('[team-detail] load failed', err);
    } finally {
      setHydrated(true);
    }
  }, [teamID]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleInvite = useCallback(
    async (email: string, role: 'coach' | 'member') => {
      try {
        setError(null);
        const res = await sendTeamInvite(teamID, email, role);
        if (res.ok) {
          setNotice({ title: 'Invite sent', body: `We emailed the invite to ${email}.` });
        } else if (res.status > 0 && res.status < 500) {
          setError(res.error ?? 'Could not send the invite.');
        } else {
          // The invite may exist without an email; share its link instead.
          const token = await getPendingInviteToken(teamID, email);
          if (!token) throw new Error('Could not send the invite.');
          const link = `${window.location.origin}/playbook/invite/${token}`;
          const errMsg = 'The email could not be sent.';
          let copied = false;
          try {
            await navigator.clipboard.writeText(link);
            copied = true;
          } catch {
            copied = false;
          }
          setNotice({
            title: 'Share this link',
            body: (
              <div className="flex flex-col gap-2">
                <span>
                  We couldn&rsquo;t email {email} automatically
                  {copied ? ' — the link is on your clipboard.' : '. Copy the link below to share it.'}
                </span>
                <code className="block px-3 py-2 rounded-card bg-surface text-[12px] text-ink font-mono break-all select-all">
                  {link}
                </code>
                <span className="text-[11px] text-faint">({errMsg})</span>
              </div>
            ),
          });
          console.warn('[team-detail] invite email failed, fell back to copy-link', res.status);
        }
        await refresh();
      } catch (err) {
        setError(formatSupabaseError(err, 'Send invite'));
        console.error('[team-detail] send invite failed', err);
      }
    },
    [teamID, refresh],
  );

  const handleRevokeInvite = useCallback(
    async (inviteID: string) => {
      try {
        setError(null);
        await revokeInvite(inviteID);
        await refresh();
      } catch (err) {
        setError(formatSupabaseError(err, 'Revoke invite'));
        console.error('[team-detail] revokeInvite failed', err);
      }
    },
    [refresh],
  );

  // A resend re-issues the invite (new link) through the same function.
  const handleResendInvite = useCallback(
    async (invite: PendingInvite) => {
      if (resendingInviteID) return;
      try {
        setError(null);
        setResendingInviteID(invite.id);
        const res = await sendTeamInvite(teamID, invite.email, invite.role);
        if (res.ok) {
          setNotice({ title: 'Invite re-sent', body: `We emailed the invite to ${invite.email} again.` });
        } else {
          setError(res.error ?? 'Could not resend the invite.');
        }
        await refresh();
      } catch (err) {
        setError(formatSupabaseError(err, 'Resend invite'));
        console.error('[team-detail] resend invite failed', err);
      } finally {
        setResendingInviteID(null);
      }
    },
    [resendingInviteID, teamID, refresh],
  );

  const handleRename = useCallback(
    async (name: string) => {
      try {
        setError(null);
        await renameTeam(teamID, name);
        await refresh();
      } catch (err) {
        setError(formatSupabaseError(err, 'Rename team'));
        console.error('[team-detail] renameTeam failed', err);
      }
    },
    [teamID, refresh],
  );

  const runPendingAction = useCallback(async () => {
    if (!pendingAction) return;
    setActionBusy(true);
    try {
      setError(null);
      if (pendingAction === 'delete') await deleteTeam(teamID);
      else await leaveTeam(teamID);
      setPendingAction(null);
      router.push('/playbook/teams');
    } catch (err) {
      setError(formatSupabaseError(err, pendingAction === 'delete' ? 'Delete team' : 'Leave team'));
      console.error(`[team-detail] ${pendingAction}Team failed`, err);
      setPendingAction(null);
    } finally {
      setActionBusy(false);
    }
  }, [pendingAction, teamID, router]);

  return (
    <PlaybookShell teams={teams} currentTeamID={teamID} onSwitchTeam={(id) => router.push(`/playbook/teams/${id}`)} pageTitle="Team">
      <div className="px-4 pt-4 pb-[calc(max(env(safe-area-inset-bottom),0.75rem)+96px)] lg:px-8 lg:pt-6 lg:pb-12">
        <div className="max-w-[860px] mx-auto">
          <Link
            href="/playbook/teams"
            className="inline-flex items-center gap-1.5 mb-4 text-[11px] font-bold tracking-[0.12em] uppercase text-muted no-underline hover:text-accent transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 3.5L5.5 8L10 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
            </svg>
            Team
          </Link>

          {error && (
            <div
              role="alert"
              className="mb-4 text-[12px] font-medium font-tight text-live bg-live/10 border border-live/30 rounded px-3 py-2"
            >
              {error}
            </div>
          )}

          {!hydrated ? (
            <p className="text-[12px] text-faint font-tight">Loading…</p>
          ) : !team ? (
            <div className="p-6 rounded-card bg-surface shadow-card flex flex-col items-start gap-2">
              <span className="text-[14px] font-bold text-ink font-tight">Team not found</span>
              <p className="text-[13px] text-muted font-medium font-tight m-0">
                You&rsquo;re not on this team, or it no longer exists.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-6 lg:mb-8">
                <TeamBadge team={team} size="md" />
                <div className="flex-1 min-w-0">
                  <h1 className="m-0 font-display italic text-[28px] lg:text-[36px] font-bold tracking-[-0.02em] leading-[0.95] text-ink truncate">
                    {team.name}
                  </h1>
                  <p className="text-muted font-medium font-tight mt-1 text-[12px] lg:text-[13px] m-0">
                    {team.memberCount} {team.memberCount === 1 ? 'member' : 'members'} · you&rsquo;re{' '}
                    {team.role === 'owner' ? 'the owner' : team.role === 'coach' ? 'a coach' : 'a member'}
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-7">
                <section>
                  <SectionHead>Members · {members?.length ?? 0}</SectionHead>
                  <ul className="flex flex-col gap-1">
                    {(members ?? []).map((m) => {
                      const displayName =
                        m.displayName ?? (m.email.includes('@') ? m.email.split('@')[0] : m.email);
                      return (
                        <li key={m.userID} className="flex items-center gap-3 px-3 py-2.5 bg-surface rounded-card-sm shadow-soft">
                          <span
                            className={[
                              'text-[10px] font-bold tracking-[0.16em] uppercase font-tight flex-shrink-0 w-[52px]',
                              m.role === 'owner' ? 'text-accent' : 'text-faint',
                            ].join(' ')}
                          >
                            {m.role}
                          </span>
                          <span className="text-[13px] font-medium text-ink font-tight truncate min-w-0 flex-1">{displayName}</span>
                          <span className="text-[11px] text-muted font-tight truncate min-w-0 hidden sm:block">{m.email}</span>
                        </li>
                      );
                    })}
                  </ul>
                </section>

                {canManage && (
                  <section>
                    <SectionHead>Pending invites · {invites.length}</SectionHead>
                    {invites.length === 0 ? (
                      <p className="text-[12px] text-faint font-tight">No pending invites.</p>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {invites.map((inv) => (
                          <li key={inv.id} className="flex items-center gap-3 px-3 py-2.5 bg-surface rounded-card-sm shadow-soft flex-wrap">
                            <span className="text-[13px] font-medium text-ink font-tight truncate flex-1 min-w-0">{inv.email}</span>
                            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted font-tight">{inv.role}</span>
                            <span className="text-[10px] font-mono text-faint">{formatExpiry(inv.expiresAt)}</span>
                            <SmallButton
                              onClick={() => handleResendInvite(inv)}
                              variant="ghost"
                              disabled={resendingInviteID === inv.id}
                            >
                              {resendingInviteID === inv.id ? 'Sending…' : 'Resend'}
                            </SmallButton>
                            <SmallButton onClick={() => handleRevokeInvite(inv.id)} variant="ghost">
                              Revoke
                            </SmallButton>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}

                {canManage && (
                  <section>
                    <SectionHead>Invite a player</SectionHead>
                    <InviteForm onSubmit={handleInvite} />
                  </section>
                )}

                <section>
                  <SectionHead>{isOwner ? 'Owner actions' : 'Membership'}</SectionHead>
                  <div className="flex items-center gap-2 flex-wrap">
                    {isOwner ? (
                      <>
                        <SmallButton onClick={() => setRenaming(true)} variant="ghost">
                          Rename
                        </SmallButton>
                        <SmallButton onClick={() => setPendingAction('delete')} variant="danger">
                          Delete team
                        </SmallButton>
                      </>
                    ) : (
                      <SmallButton onClick={() => setPendingAction('leave')} variant="danger">
                        Leave team
                      </SmallButton>
                    )}
                  </div>
                </section>
              </div>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction === 'delete' ? `Delete “${team?.name ?? 'this team'}”?` : `Leave “${team?.name ?? 'this team'}”?`}
        body={
          pendingAction === 'delete'
            ? 'Members lose access and every play on this team is removed. This can’t be undone.'
            : 'You’ll lose access to this team’s plays. You can rejoin if someone invites you again.'
        }
        confirmLabel={pendingAction === 'delete' ? 'Delete' : 'Leave'}
        busyLabel={pendingAction === 'delete' ? 'Deleting…' : 'Leaving…'}
        busy={actionBusy}
        onConfirm={runPendingAction}
        onCancel={() => setPendingAction(null)}
      />

      <PromptDialog
        open={renaming}
        title="Rename team"
        label="Team name"
        initialValue={team?.name ?? ''}
        maxLength={60}
        confirmLabel="Save"
        onSubmit={async (value) => {
          setRenaming(false);
          if (team && value !== team.name) await handleRename(value);
        }}
        onCancel={() => setRenaming(false)}
      />

      <AlertDialog open={notice !== null} title={notice?.title ?? ''} body={notice?.body} onClose={() => setNotice(null)} />
    </PlaybookShell>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[10px] font-bold tracking-[0.18em] uppercase font-tight mb-3 pb-2 border-b border-hairline text-muted">
      {children}
    </h2>
  );
}

function InviteForm({ onSubmit }: { onSubmit: (email: string, role: 'coach' | 'member') => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'coach' | 'member'>('member');
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const trimmed = email.trim().toLowerCase();
        if (!trimmed || busy) return;
        setBusy(true);
        try {
          await onSubmit(trimmed, role);
          setEmail('');
        } finally {
          setBusy(false);
        }
      }}
      className="p-3 bg-surface flex items-center gap-2 flex-wrap rounded-card shadow-card"
    >
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        placeholder="player@example.com"
        className="flex-1 min-w-[180px] bg-bg border border-border px-2 py-1.5 text-[12px] text-ink font-tight focus-visible:outline-none focus-visible:border-ink rounded"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as 'coach' | 'member')}
        className="bg-bg border border-border px-2 py-1.5 text-[11px] font-bold tracking-[0.14em] uppercase text-ink font-tight rounded cursor-pointer focus-visible:outline-none focus-visible:border-ink"
      >
        <option value="member">Member</option>
        <option value="coach">Coach</option>
      </select>
      <SmallButton onClick={() => {}} variant="primary" type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send invite'}
      </SmallButton>
    </form>
  );
}

function SmallButton({
  children,
  onClick,
  variant = 'ghost',
  type = 'button',
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
}) {
  const base =
    'inline-flex items-center px-3 py-1.5 text-[10px] font-bold tracking-[0.14em] uppercase font-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-full disabled:opacity-50 disabled:pointer-events-none';
  const variantCls =
    variant === 'primary'
      ? 'bg-ink text-bg hover:opacity-90'
      : variant === 'danger'
        ? 'bg-transparent text-faint hover:text-live'
        : 'bg-ink/5 text-muted hover:text-ink hover:bg-ink/10';
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${disabled ? '' : 'cursor-pointer'} ${variantCls}`}>
      {children}
    </button>
  );
}
