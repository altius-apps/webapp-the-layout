// Edge Function: invite-email
//
// Creates (or refreshes) an email invite and sends it via Resend, for both
// invite kinds (Hunter, 2026-10-09: one shared function, called by the app and
// by web):
//   { kind: 'fantasy',  leagueId, email }        → fantasy_create_league_invite
//   { kind: 'playbook', teamId, email, role }    → create_team_invite
// Supersedes fantasy-invite-email (same fantasy logic), deleted 2026-10-09
// once web and the app both called this one.
//
// Ports web's league-invite-email.ts (fantasy) and playbook/teams/actions.ts
// (playbook); the email templates are byte-for-byte. This function creates the
// invite itself, so the token never leaves the server. Both RPCs stamp
// last_sent_at on every (re)issue and cap sends at 3 per address per scope per
// rolling 24 h (migrations 20261010031548 + 20261010032547), so the 60 s
// cooldown is read BEFORE the RPC.
//
// AUTH MODEL: every query runs as the caller (anon key + their JWT), so RLS
// and the SECURITY DEFINER RPCs' own permission checks apply. No service-role
// client. The gateway verifies the JWT (verify_jwt on); getUser re-checks it.
//
// Returns:
//   200 { ok: true }
//   400 { error }  invalid input
//   401 { error }  missing/invalid token
//   403 { error }  not the league's commissioner / not a team owner or coach
//   404 { error }  league / team not found
//   429 { error }  resend cooldown, hourly limit, or 3-per-address-per-day cap
//   5xx { error }  generic; details stay in the logs
//
// Env: RESEND_API, SEND_EMAIL (function secrets); SITE_URL optional, defaults
// to https://thelayout.app. Never derived from the request.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const INVITE_RATE_LIMIT_PER_HOUR = 20;
const RESEND_COOLDOWN_MS = 60 * 1000;
// Stricter than web's /^[^\s@]+@[^\s@]+\.[^\s@]+$/: no <>,;"() so a
// "Name <addr>" string can't make Resend deliver somewhere other than the
// address the invite is stored under.
const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const EMAIL_MAX_LENGTH = 254;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 2048;

type PlaybookRole = 'coach' | 'member';

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripNewlines(str: string): string {
  return str.replace(/[\r\n]+/g, ' ');
}

// ─── Fantasy template (web src/lib/fantasy/league-invite-email.ts) ──────────

function buildFantasyHtml(params: { inviterName: string | null; leagueName: string; acceptUrl: string }): string {
  const { inviterName, leagueName, acceptUrl } = params;
  const senderLabel = inviterName ? inviterName : 'A league commissioner';
  const safeUrl = escapeHtml(acceptUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Fantasy league invite</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;padding:0 24px;">

          <!-- Wordmark -->
          <tr>
            <td style="padding-bottom:32px;">
              <span style="font-size:18px;font-weight:800;letter-spacing:-0.03em;color:#0d0d0d;">The Layout</span>
            </td>
          </tr>

          <!-- Heading -->
          <tr>
            <td style="padding-bottom:16px;">
              <h1 style="margin:0;font-size:24px;font-weight:700;letter-spacing:-0.02em;color:#0d0d0d;line-height:1.2;">
                You're invited to the fantasy league<br />${escapeHtml(leagueName)}
              </h1>
            </td>
          </tr>

          <!-- Body copy -->
          <tr>
            <td style="padding-bottom:32px;">
              <p style="margin:0;font-size:15px;line-height:1.6;color:#444444;">
                ${escapeHtml(senderLabel)} invited you to join
                <strong style="color:#0d0d0d;">${escapeHtml(leagueName)}</strong>,
                a fantasy ultimate league on The Layout.
              </p>
              <p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:#666666;">
                This invite expires in 14 days. Sign in with this email address to accept it.
              </p>
            </td>
          </tr>

          <!-- CTA button -->
          <tr>
            <td style="padding-bottom:40px;">
              <a href="${safeUrl}"
                 style="display:inline-block;background:#FF3D00;color:#ffffff;text-decoration:none;
                        font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;
                        padding:14px 28px;border-radius:6px;line-height:1;">
                Join the league
              </a>
            </td>
          </tr>

          <!-- Fallback link -->
          <tr>
            <td style="padding-bottom:32px;">
              <p style="margin:0;font-size:12px;color:#999999;line-height:1.5;">
                Button not working? Copy and paste this link into your browser:<br />
                <a href="${safeUrl}" style="color:#FF3D00;word-break:break-all;">${safeUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer rule -->
          <tr>
            <td style="border-top:1px solid #eeeeee;padding-top:24px;">
              <p style="margin:0;font-size:11px;color:#bbbbbb;line-height:1.5;">
                You received this because someone invited you to a fantasy league on The Layout.
                If you weren't expecting this, you can safely ignore it.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildFantasyText(params: { inviterName: string | null; leagueName: string; acceptUrl: string }): string {
  const { inviterName, leagueName, acceptUrl } = params;
  const safeLeague = stripNewlines(leagueName);
  const senderLabel = stripNewlines(inviterName ? inviterName : 'A league commissioner');
  return [
    `You're invited to the fantasy league ${safeLeague} on The Layout`,
    '',
    `${senderLabel} invited you to join ${safeLeague}, a fantasy ultimate league on The Layout.`,
    '',
    'Join here:',
    acceptUrl,
    '',
    'This invite expires in 14 days. Sign in with this email address to accept it.',
    '',
    "If you weren't expecting this, you can safely ignore this email.",
  ].join('\n');
}

// ─── Playbook template (web src/app/playbook/teams/actions.ts) ──────────────

function buildPlaybookHtml(params: {
  inviterName: string | null;
  teamName: string;
  role: PlaybookRole;
  acceptUrl: string;
}): string {
  const { inviterName, teamName, role, acceptUrl } = params;
  const senderLabel = inviterName ? inviterName : 'A team owner';
  const roleLabel = role === 'coach' ? 'coach' : 'player';
  const safeUrl = escapeHtml(acceptUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Team invite</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;padding:0 24px;">

          <!-- Wordmark -->
          <tr>
            <td style="padding-bottom:32px;">
              <span style="font-size:18px;font-weight:800;letter-spacing:-0.03em;color:#0d0d0d;">The Layout</span>
            </td>
          </tr>

          <!-- Heading -->
          <tr>
            <td style="padding-bottom:16px;">
              <h1 style="margin:0;font-size:24px;font-weight:700;letter-spacing:-0.02em;color:#0d0d0d;line-height:1.2;">
                You're invited to join<br />${escapeHtml(teamName)}
              </h1>
            </td>
          </tr>

          <!-- Body copy -->
          <tr>
            <td style="padding-bottom:32px;">
              <p style="margin:0;font-size:15px;line-height:1.6;color:#444444;">
                ${escapeHtml(senderLabel)} invited you to join
                <strong style="color:#0d0d0d;">${escapeHtml(teamName)}</strong> on
                The Layout as a <strong style="color:#0d0d0d;">${roleLabel}</strong>.
              </p>
              <p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:#666666;">
                This invite expires in 14 days. Sign in with this email address to accept it.
              </p>
            </td>
          </tr>

          <!-- CTA button -->
          <tr>
            <td style="padding-bottom:40px;">
              <a href="${safeUrl}"
                 style="display:inline-block;background:#FF3D00;color:#ffffff;text-decoration:none;
                        font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;
                        padding:14px 28px;border-radius:6px;line-height:1;">
                Accept invite
              </a>
            </td>
          </tr>

          <!-- Fallback link -->
          <tr>
            <td style="padding-bottom:32px;">
              <p style="margin:0;font-size:12px;color:#999999;line-height:1.5;">
                Button not working? Copy and paste this link into your browser:<br />
                <a href="${safeUrl}" style="color:#FF3D00;word-break:break-all;">${safeUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer rule -->
          <tr>
            <td style="border-top:1px solid #eeeeee;padding-top:24px;">
              <p style="margin:0;font-size:11px;color:#bbbbbb;line-height:1.5;">
                You received this because someone invited you to a team on The Layout.
                If you weren't expecting this, you can safely ignore it.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildPlaybookText(params: {
  inviterName: string | null;
  teamName: string;
  role: PlaybookRole;
  acceptUrl: string;
}): string {
  const { inviterName, teamName, role, acceptUrl } = params;
  const safeTeam = stripNewlines(teamName);
  const senderLabel = stripNewlines(inviterName ? inviterName : 'A team owner');
  const roleLabel = role === 'coach' ? 'coach' : 'player';
  return [
    `You're invited to join ${safeTeam} on The Layout`,
    '',
    `${senderLabel} invited you to join ${safeTeam} as a ${roleLabel}.`,
    '',
    'Accept your invite here:',
    acceptUrl,
    '',
    'This invite expires in 14 days. Sign in with this email address to accept it.',
    '',
    "If you weren't expecting this, you can safely ignore this email.",
  ].join('\n');
}

// ─── Shared send flow ────────────────────────────────────────────────────────

/** What differs between the two kinds once the caller is authorized. */
interface InviteSpec {
  table: 'fantasy_league_invites' | 'pb_team_invites';
  scopeColumn: 'league_id' | 'team_id';
  scopeId: string;
  rpc: string;
  rpcArgs: Record<string, string>;
  acceptPath: string;
  scopeName: string;
  html: (acceptUrl: string) => string;
  text: (acceptUrl: string) => string;
}

async function sendInvite(
  db: SupabaseClient,
  userId: string,
  email: string,
  spec: InviteSpec,
  env: { RESEND_API: string; SEND_EMAIL: string; SITE_URL: string },
): Promise<Response> {
  // 60 s cooldown, read before the RPC re-stamps last_sent_at.
  const { data: pending, error: pendingErr } = await db
    .from(spec.table)
    .select('last_sent_at')
    .eq(spec.scopeColumn, spec.scopeId)
    .eq('email', email)
    .is('accepted_at', null)
    .maybeSingle();
  if (pendingErr) return json(500, { error: 'Could not verify the invite.' });
  if (pending?.last_sent_at) {
    const elapsedMs = Date.now() - new Date(pending.last_sent_at as string).getTime();
    if (elapsedMs < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000);
      return json(429, { error: `Please wait ${waitSec}s before resending this invite.` });
    }
  }

  // Rolling-hour limit per inviter: invites SENT in the last hour (the RPC
  // stamps last_sent_at on every create and refresh).
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const sentLastHour = async (): Promise<number | null> => {
    const { count, error } = await db
      .from(spec.table)
      .select('id', { count: 'exact', head: true })
      .eq('invited_by', userId)
      .gte('last_sent_at', oneHourAgo);
    return error ? null : (count ?? 0);
  };
  const before = await sentLastHour();
  if (before == null) return json(500, { error: 'Could not verify invite rate limit.' });
  if (before >= INVITE_RATE_LIMIT_PER_HOUR) {
    return json(429, { error: 'Too many invites sent recently. Please try again later.' });
  }

  // Create or refresh as the caller. A refresh rotates the token, so an
  // earlier email's link stops working — the newest email wins.
  const { data: created, error: rpcErr } = await db.rpc(spec.rpc, spec.rpcArgs);
  if (rpcErr?.message?.includes('invite_resend_limit')) {
    return json(429, { error: 'This address was already invited 3 times today. Try again tomorrow.' });
  }
  // The DB's per-inviter hourly cap across both kinds (invite_sends log).
  if (rpcErr?.message?.includes('invite_rate_limit')) {
    return json(429, { error: 'Too many invites sent recently. Please try again later.' });
  }
  const row = (Array.isArray(created) ? created[0] : created) as { token?: string } | null;
  if (rpcErr || !row?.token) {
    console.error('[invite-email] create failed', spec.rpc, rpcErr?.message);
    return json(500, { error: 'Could not create the invite.' });
  }

  // Re-count with this request's row committed: parallel requests all pass the
  // first check, but each sees the others' rows here.
  const after = await sentLastHour();
  if (after == null || after > INVITE_RATE_LIMIT_PER_HOUR) {
    return json(429, { error: 'Too many invites sent recently. Please try again later.' });
  }

  const acceptUrl = `${env.SITE_URL}${spec.acceptPath}${row.token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `The Layout <${env.SEND_EMAIL}>`,
      to: [email],
      subject: `You're invited to ${stripNewlines(spec.scopeName)} on The Layout`,
      html: spec.html(acceptUrl),
      text: spec.text(acceptUrl),
    }),
  });
  console.info('[invite-email] send', {
    kind: spec.rpc,
    inviterId: userId,
    scopeId: spec.scopeId,
    outcome: res.ok ? 'sent' : 'failed',
  });
  if (!res.ok) {
    // Provider detail stays in the logs; the caller gets a fixed string.
    console.error('[invite-email] Resend error', res.status, await res.text());
    return json(502, { error: 'Could not send the invite email. Try again later.' });
  }
  return json(200, { ok: true });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const RESEND_API = Deno.env.get('RESEND_API');
  const SEND_EMAIL = Deno.env.get('SEND_EMAIL');
  const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://thelayout.app').replace(/\/$/, '');
  if (!SUPABASE_URL || !ANON_KEY || !RESEND_API || !SEND_EMAIL) {
    console.error('[invite-email] missing env');
    return json(500, { error: 'Email invites are not available right now.' });
  }
  const env = { RESEND_API, SEND_EMAIL, SITE_URL };

  // Caller.
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'Sign in to send invites.' });
  const db = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await db.auth.getUser(jwt);
  if (userErr || !userData?.user) return json(401, { error: 'Sign in to send invites.' });
  const userId = userData.user.id;

  // Input.
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(400, { error: 'Request too large.' });
  let body: { kind?: unknown; leagueId?: unknown; teamId?: unknown; email?: unknown; role?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Invalid request.' });
  }
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : null;
  if (!email || email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) {
    return json(400, { error: 'Invalid email address.' });
  }

  const { data: profile } = await db.from('profiles').select('display_name').eq('id', userId).maybeSingle();
  const inviterName = (profile?.display_name as string | null) ?? null;

  if (body?.kind === 'fantasy') {
    const leagueId = body.leagueId;
    if (typeof leagueId !== 'string' || !UUID_RE.test(leagueId)) return json(400, { error: 'Invalid league id.' });

    // Commissioner of this league (the RPC re-checks).
    const { data: membership, error: memberErr } = await db
      .from('fantasy_league_members')
      .select('role')
      .eq('league_id', leagueId)
      .eq('user_id', userId)
      .eq('role', 'commissioner')
      .maybeSingle();
    if (memberErr) return json(500, { error: 'Could not verify league access.' });
    if (!membership) return json(403, { error: 'Not authorized' });

    const { data: league, error: leagueErr } = await db
      .from('fantasy_leagues')
      .select('name')
      .eq('id', leagueId)
      .maybeSingle();
    if (leagueErr) return json(500, { error: 'Could not load league.' });
    if (!league) return json(404, { error: 'League not found' });
    const leagueName = league.name as string;

    return sendInvite(db, userId, email, {
      table: 'fantasy_league_invites',
      scopeColumn: 'league_id',
      scopeId: leagueId,
      rpc: 'fantasy_create_league_invite',
      rpcArgs: { p_league: leagueId, p_email: email },
      acceptPath: '/fantasy/invite/',
      scopeName: leagueName,
      html: (acceptUrl) => buildFantasyHtml({ inviterName, leagueName, acceptUrl }),
      text: (acceptUrl) => buildFantasyText({ inviterName, leagueName, acceptUrl }),
    }, env);
  }

  if (body?.kind === 'playbook') {
    const teamId = body.teamId;
    if (typeof teamId !== 'string' || !UUID_RE.test(teamId)) return json(400, { error: 'Invalid team id.' });
    const role = body.role;
    if (role !== 'coach' && role !== 'member') return json(400, { error: 'Invalid role.' });

    // Team owner or coach (web assertTeamEditor; the RPC re-checks).
    const { data: membership, error: memberErr } = await db
      .from('pb_team_members')
      .select('role')
      .eq('team_id', teamId)
      .eq('user_id', userId)
      .in('role', ['owner', 'coach'])
      .maybeSingle();
    if (memberErr) return json(500, { error: 'Could not verify team access.' });
    if (!membership) return json(403, { error: 'Not authorized' });

    const { data: team, error: teamErr } = await db.from('pb_teams').select('name').eq('id', teamId).maybeSingle();
    if (teamErr) return json(500, { error: 'Could not load team.' });
    if (!team) return json(404, { error: 'Team not found' });
    const teamName = team.name as string;

    return sendInvite(db, userId, email, {
      table: 'pb_team_invites',
      scopeColumn: 'team_id',
      scopeId: teamId,
      rpc: 'create_team_invite',
      rpcArgs: { p_team_id: teamId, p_email: email, p_role: role },
      acceptPath: '/playbook/invite/',
      scopeName: teamName,
      html: (acceptUrl) => buildPlaybookHtml({ inviterName, teamName, role, acceptUrl }),
      text: (acceptUrl) => buildPlaybookText({ inviterName, teamName, role, acceptUrl }),
    }, env);
  }

  return json(400, { error: 'Invalid request.' });
});
