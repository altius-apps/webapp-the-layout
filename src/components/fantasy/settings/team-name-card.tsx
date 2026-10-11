'use client';

// The member's own team name (any member, commissioner included). Teams are
// created automatically under the member's display name; this is where they
// rename it (Hunter, 2026-10-09). Renders nothing until the team exists.

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getMyContestTeam, renameContestTeam, type ContestView } from '@/lib/fantasy/leagues';
import { revalidateFantasyLeague } from '@/app/fantasy/leagues/actions';
import { Card, Feedback, SaveButton } from './shared';

export function TeamNameCard({ contest }: { contest: ContestView }) {
  const router = useRouter();
  const inputId = useId();
  const [team, setTeam] = useState<{ id: string; teamName: string } | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMyContestTeam(contest.id).then((t) => {
      if (cancelled || !t) return;
      setTeam(t);
      setName(t.teamName);
    });
    return () => {
      cancelled = true;
    };
  }, [contest.id]);

  if (!team) return null;

  const trimmed = name.trim();
  const canSave = trimmed !== team.teamName && trimmed.length >= 1 && trimmed.length <= 40 && !saving;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await renameContestTeam(team.id, trimmed);
      await revalidateFantasyLeague(contest.leagueId, contest.id).catch(() => null);
      setTeam({ ...team, teamName: trimmed });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename your team.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Your team name">
      <form onSubmit={save} className="flex items-center gap-3 max-w-[520px]">
        <div className="flex-1 min-w-0">
          <label htmlFor={inputId} className="sr-only">
            Team name
          </label>
          <input
            id={inputId}
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
              setSaved(false);
            }}
            maxLength={40}
            className={[
              'w-full px-3.5 py-2.5 rounded-card-sm bg-ink/5',
              'font-tight text-[14px] text-ink placeholder:text-faint',
              'focus:outline-none focus:ring-2 focus:ring-accent min-h-[44px]',
            ].join(' ')}
          />
        </div>
        <SaveButton disabled={!canSave} saving={saving} />
      </form>
      <Feedback error={error} saved={saved} />
    </Card>
  );
}
