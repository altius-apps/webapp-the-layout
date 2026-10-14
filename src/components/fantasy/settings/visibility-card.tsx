'use client';

// Commissioner switch: list the league in Fantasy → Public. Saves on toggle.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setLeaguePublic } from '@/lib/fantasy/leagues';
import { revalidateFantasyLeague } from '@/app/fantasy/leagues/actions';
import { Card, Feedback, ToggleSwitch } from './shared';

export function VisibilityCard({ leagueId, initialPublic }: { leagueId: string; initialPublic: boolean }) {
  const router = useRouter();
  const [isPublic, setIsPublic] = useState(initialPublic);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const toggle = async () => {
    const next = !isPublic;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setLeaguePublic(leagueId, next);
      setIsPublic(next);
      await revalidateFantasyLeague(leagueId).catch(() => null);
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the league.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Visibility">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-tight text-[13.5px] font-semibold text-ink">Public league</p>
          <p className="font-tight text-[11.5px] text-faint mt-0.5">
            Anyone can find and join it from Fantasy → Public. Drafted leagues still cap at 16 teams.
          </p>
        </div>
        <ToggleSwitch checked={isPublic} onChange={toggle} disabled={saving} label="Public league" />
      </div>
      <Feedback error={error} saved={saved} />
    </Card>
  );
}
