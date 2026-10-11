// /euf/events/[slug]/leaders — event scoring leaders.
//
// EUCS is one of the few sources that publishes per-player goals AND assists,
// so this is a real leaderboard rather than a roster dump.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { PageShell } from '@/components/page-shell';
import { getEvent, getEventLeaders } from '@/lib/euf/data';
import { EufFlag } from '@/components/euf/euf-flag';

export const revalidate = 300;

// SSG mode with on-demand paths — see /players/[id]. Without this export the
// revalidate above never engages and every hit is request-rendered.
export function generateStaticParams(): { slug: string }[] {
  return [];
}

interface Props {
  params: { slug: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ev = await getEvent(params.slug).catch(() => null);
  if (!ev) return { title: 'Event not found · The Layout' };
  return { title: `Leaders · ${ev.name} · The Layout` };
}

export default async function EufLeadersPage({ params }: Props) {
  const ev = await getEvent(params.slug);
  if (!ev) notFound();

  const leaders = await getEventLeaders(ev.id, undefined, 100).catch(() => []);

  return (
    <PageShell
      title="Scoring Leaders"
      eyebrow={`EUCS · ${ev.name}`}
      subtitle="Goals and assists across the event."
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'EUCS', href: '/euf/events' },
        { label: ev.name, href: `/euf/events/${ev.slug}` },
        { label: 'Leaders' },
      ]}
    >
      {leaders.length === 0 ? (
        <p className="text-muted font-tight text-[13px]">No player stats available.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse">
            <thead>
              <tr className="text-[10px] font-bold tracking-[0.12em] uppercase text-muted font-tight">
                <th className="text-left py-2 pr-2 font-bold">Player</th>
                <th className="text-left py-2 px-2 font-bold">Team</th>
                <th className="text-right py-2 px-2 font-bold">GP</th>
                <th className="text-right py-2 px-2 font-bold">G</th>
                <th className="text-right py-2 px-2 font-bold">A</th>
                <th className="text-right py-2 pl-2 font-bold">Pts</th>
              </tr>
            </thead>
            <tbody>
              {leaders.map((p, i) => (
                <tr key={`${p.teamId}-${p.fullName}-${i}`} className="border-t border-hairline">
                  <td className="py-2 pr-2 text-[13px] font-tight text-ink whitespace-nowrap">
                    <Link
                      href={`/euf/players/by-name/${encodeURIComponent(p.fullName)}`}
                      prefetch={false}
                      className="no-underline hover:underline text-ink"
                    >
                      {p.fullName}
                    </Link>
                  </td>
                  <td className="py-2 px-2 text-[13px] font-tight text-muted">
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                      <EufFlag countryName={p.countryName} size={13} />
                      {p.teamName ? (
                        <Link
                          href={`/euf/clubs/${encodeURIComponent(p.teamName)}?div=${encodeURIComponent(p.division)}&season=${ev.year}`}
                          prefetch={false}
                          className="truncate no-underline hover:underline text-muted"
                        >
                          {p.teamName}
                        </Link>
                      ) : (
                        <span className="truncate">{p.teamName}</span>
                      )}
                    </span>
                  </td>
                  <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-muted">
                    {p.games ?? '–'}
                  </td>
                  <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-ink">
                    {p.goals}
                  </td>
                  <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-muted">
                    {p.assists}
                  </td>
                  <td className="text-right py-2 pl-2 text-[13px] font-tight tabular-nums text-ink font-semibold">
                    {p.total}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
