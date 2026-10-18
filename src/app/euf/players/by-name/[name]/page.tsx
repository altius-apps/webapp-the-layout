// /euf/players/by-name/[name] — resolves an EUCS roster name to a player.
//
// Routed BY NAME, not by id: EUF player ids are per-event (the same human gets a
// new id at each event), so the name is the only stable key. Mirrors the WFDF
// by-name route: first try to resolve the name to an anchor-league profile
// (USAU → UFA) and redirect to the full unified profile; only when the person
// exists in no anchor league do we render this by-name profile — and then we
// still merge in their WFDF appearances so the career is complete.

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { PageShell } from '@/components/page-shell';
import { getPlayerProfileByName } from '@/lib/euf/data';
import { getWfdfPlayerStints } from '@/lib/wfdf/data';
import { resolveWfdfPlayerAnchor } from '@/lib/wfdf/anchor';
import { EufFlag } from '@/components/euf/euf-flag';
import { WfdfFlag } from '@/components/wfdf/wfdf-flag';

export const revalidate = 300;

// SSG mode with on-demand paths: without this export the revalidate above
// never engages and every crawler hit re-runs the name-resolution RPCs.
export function generateStaticParams(): { name: string }[] {
  return [];
}

interface Props {
  params: { name: string };
}

// A malformed %-sequence used to throw a 500 here (the WFDF page already guards it).
function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const name = decodeName(params.name);
  return { title: `${name} · EUCS · The Layout` };
}

export default async function EufPlayerPage({ params }: Props) {
  const name = decodeName(params.name);

  // 1. Anchor-league identity (USAU → UFA) wins: the unified profile carries
  //    the person's FULL career (EUCS and WFDF stints included), so hand off.
  //    The resolver is name-based, not WFDF-specific, despite its home module.
  const anchor = await resolveWfdfPlayerAnchor(name).catch(() => null);
  if (anchor) redirect(`/players/${anchor.anchorId}?from=euf`);

  // 2. No anchor — by-name profile from EUCS rosters, plus any WFDF stints so
  //    a Europe-only player still gets their whole history on one page.
  const [profile, wfdfStints] = await Promise.all([
    getPlayerProfileByName(name),
    getWfdfPlayerStints(name).catch(() => []),
  ]);
  if (!profile) notFound();

  const { totals, appearances } = profile;
  // Most-recent CLUB, not nationality — 1.9% of EUF players appear for clubs in
  // more than one country, so labelling the country alone would misread as a
  // passport. Name the club it came from.
  const latest = appearances[0];
  const clubLine = latest ? `${latest.teamName} (${latest.countryName ?? '—'})` : null;

  return (
    <PageShell
      title={profile.fullName}
      eyebrow="EUCS · Player"
      subtitle={[clubLine, `${totals.events} ${totals.events === 1 ? 'event' : 'events'}`]
        .filter(Boolean)
        .join(' · ')}
      stickyName={profile.fullName}
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'EUCS', href: '/euf/events' },
        { label: profile.fullName },
      ]}
    >
      <div className="flex flex-col gap-6">
        {/* Career totals */}
        <section className="grid grid-cols-4 gap-2">
          {[
            ['Games', totals.games],
            ['Goals', totals.goals],
            ['Assists', totals.assists],
            ['Points', totals.points],
          ].map(([label, value]) => (
            <div key={label as string} className="rounded-card bg-surface shadow-card p-3">
              <p className="text-[9px] font-bold tracking-[0.14em] uppercase text-faint font-tight">
                {label}
              </p>
              <p className="text-[20px] font-semibold text-ink font-tight tabular-nums">{value}</p>
            </div>
          ))}
        </section>

        {/* Appearance-by-appearance */}
        <section>
          <h2 className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline">
            Event History
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse">
              <thead>
                <tr className="text-[10px] font-bold tracking-[0.12em] uppercase text-muted font-tight">
                  <th className="text-left py-2 pr-2 font-bold">Event</th>
                  <th className="text-left py-2 px-2 font-bold">Team</th>
                  <th className="text-right py-2 px-2 font-bold">Fin</th>
                  <th className="text-right py-2 px-2 font-bold">GP</th>
                  <th className="text-right py-2 px-2 font-bold">G</th>
                  <th className="text-right py-2 px-2 font-bold">A</th>
                  <th className="text-right py-2 pl-2 font-bold">Pts</th>
                </tr>
              </thead>
              <tbody>
                {appearances.map((a, i) => (
                  <tr key={`${a.teamId}-${i}`} className="border-t border-hairline">
                    <td className="py-2 pr-2 text-[13px] font-tight">
                      <Link
                        href={`/euf/events/${a.eventSlug}`}
                        prefetch={false}
                        className="no-underline hover:underline text-ink"
                      >
                        {a.eventName}
                      </Link>
                      <span className="text-muted ml-1.5 text-[11px]">{a.division}</span>
                    </td>
                    <td className="py-2 px-2 text-[13px] font-tight">
                      <Link
                        href={`/euf/clubs/${encodeURIComponent(a.teamName)}?div=${encodeURIComponent(a.division)}&season=${a.year}`}
                        prefetch={false}
                        className="inline-flex items-center gap-1.5 no-underline hover:underline text-muted min-w-0"
                      >
                        <EufFlag countryName={a.countryName} size={13} />
                        <span className="truncate">{a.teamName}</span>
                      </Link>
                    </td>
                    <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-muted">
                      {a.finalPlacement ?? '–'}
                    </td>
                    <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-muted">
                      {a.games ?? '–'}
                    </td>
                    <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-ink">
                      {a.goals ?? 0}
                    </td>
                    <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-muted">
                      {a.assists ?? 0}
                    </td>
                    <td className="text-right py-2 pl-2 text-[13px] font-tight tabular-nums text-ink font-semibold">
                      {a.total ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* WFDF Worlds appearances — same card list the WFDF by-name profile
            renders, so the person's international career shows here too. */}
        {wfdfStints.length > 0 && (
          <section aria-labelledby="euf-wfdf-heading">
            <h2
              id="euf-wfdf-heading"
              className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline"
            >
              WFDF Appearances
            </h2>
            <ul className="flex flex-col gap-2 list-none p-0 m-0 mt-3">
              {wfdfStints.map((s, i) => (
                <li key={`${s.teamId}-${i}`}>
                  <Link
                    href={`/wfdf/teams/${s.teamId}`}
                    prefetch={false}
                    className={[
                      'flex items-center gap-3 bg-surface rounded-card px-4 py-3',
                      'shadow-card transition-shadow hover:shadow-lift cursor-pointer no-underline',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    ].join(' ')}
                  >
                    <span className="text-[13px] font-bold tabular text-faint w-10 flex-shrink-0">
                      {s.year}
                    </span>
                    <WfdfFlag flagFile={null} countryCode={s.countryCode} size={18} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-semibold text-ink font-tight truncate">
                        {s.teamName}
                        {s.isChampion && <span className="text-accent ml-1.5">★</span>}
                      </span>
                      <span className="block text-[11px] text-muted font-tight truncate mt-0.5">
                        {[s.eventName, s.divisionName].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="text-[11px] text-faint font-tight tabular flex-shrink-0">
                      {s.goals != null || s.assists != null
                        ? `${s.goals ?? 0}G · ${s.assists ?? 0}A`
                        : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </PageShell>
  );
}
