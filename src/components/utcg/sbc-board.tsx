'use client';

// SbcBoard — Collection tab's "SBCs" sub-tab. Lists Squad Building Challenges
// (utcg_sbc_defs); selecting one opens a picker built from the owned
// collection so the player can hand in the exact copies requested. Requirement
// chips + live sbcMet() give instant legality feedback before submit; the
// server re-checks everything and is the source of truth.
//
// Picker shell copied from SquadBuilder's SlotPicker (bg-black/40 backdrop +
// bottom-sheet-on-mobile/centered-on-desktop + Escape-to-close) — the
// established modal idiom for the whole game.

import { useEffect, useMemo, useState } from 'react';
import type { OwnedCard } from '@/lib/utcg/server';
import type { UtcgCard } from '@/lib/utcg/data';
import type { Sbc, SbcRequirements } from '@/lib/utcg/sinks';
import { sbcMet } from '@/lib/utcg/sinks';
import { PACKS } from '@/lib/utcg/packs';
import { CardTile } from '@/components/utcg/card-tile';

interface SbcBoardProps {
  sbcs: Sbc[];
  owned: OwnedCard[];
  onSubmit: (key: string, cards: { playerId: string; teamSlug: string; year: number }[]) => Promise<void>;
  submitting: boolean;
  submitError: string | null;
  submittingKey: string | null;
}

function cardKeyOf(c: { playerId: string; teamSlug: string; year: number }): string {
  return `${c.playerId}|${c.teamSlug}|${c.year}`;
}

// The TOTW Upgrade SBC rewards a card, not a pack ('totw' has no PACKS entry).
function rewardLabel(pack: Sbc['rewardPack']): string {
  return pack === 'totw' ? 'TOTW card' : PACKS[pack].name;
}

function requirementChips(req: SbcRequirements): string[] {
  const chips: string[] = [`${req.count} cards`];
  if (req.min_avg !== undefined) chips.push(`${req.min_avg}+ avg`);
  if (req.min_rank !== undefined) chips.push(`${tierLabelFromRank(req.min_rank)}+`);
  if (req.max_rank !== undefined) chips.push(`${tierLabelFromRank(req.max_rank)} or below`);
  if (req.same_team) chips.push('same team');
  if (req.min_teams !== undefined) chips.push(`${req.min_teams}+ teams`);
  if (req.max_teams !== undefined) chips.push(`max ${req.max_teams} teams`);
  if (req.min_year !== undefined) chips.push(`${req.min_year}+`);
  if (req.max_year !== undefined) chips.push(`${req.max_year} or earlier`);
  if (req.rank_at_least) chips.push(`${req.rank_at_least.count}+ at ${tierLabelFromRank(req.rank_at_least.rank)}+`);
  return chips;
}

// tier_rank (1..7) -> a short label, matching packs.ts TIERS order reversed.
function tierLabelFromRank(rank: number): string {
  const labels = ['', 'Fringe', 'League Avg', 'Contributor', 'Solid Pro', 'Star', 'Elite', 'Greatest'];
  return labels[rank] ?? 'Fringe';
}

export function SbcBoard({ sbcs, owned, onSubmit, submitting, submitError, submittingKey }: SbcBoardProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openSbc = sbcs.find((s) => s.key === openKey) ?? null;

  if (sbcs.length === 0) {
    return <p className="text-[13px] text-muted font-tight text-center py-12">No SBCs available right now.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {submitError && (
        <p className="text-[12px] text-live font-tight" role="alert">{submitError}</p>
      )}
      {sbcs.map((sbc) => {
        const locked = sbc.completed && !sbc.repeatable;
        const weeklyCapped = sbc.repeatable && sbc.weeklyLimit !== null && sbc.doneThisWeek >= sbc.weeklyLimit;
        const disabled = locked || weeklyCapped;
        return (
          <div key={sbc.key} className="rounded-card-lg bg-surface shadow-card p-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-display italic text-lg font-bold text-ink leading-tight">{sbc.name}</p>
                <p className="text-[12px] text-muted font-tight mt-0.5">{sbc.description}</p>
              </div>
              <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-faint font-tight flex-shrink-0 whitespace-nowrap">
                {rewardLabel(sbc.rewardPack)}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {requirementChips(sbc.requirements).map((c) => (
                <span key={c} className="text-[9.5px] font-bold tracking-[0.04em] uppercase px-2 py-1 rounded-full bg-ink/5 text-ink/70 leading-none">
                  {c}
                </span>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10.5px] text-faint font-tight">
                {locked
                  ? 'Completed'
                  : sbc.repeatable && sbc.weeklyLimit !== null
                    ? `${sbc.doneThisWeek}/${sbc.weeklyLimit} this week`
                    : sbc.repeatable
                      ? 'Repeatable'
                      : 'One-time'}
              </span>
              <button
                type="button"
                onClick={() => setOpenKey(sbc.key)}
                disabled={disabled}
                className={[
                  'inline-flex items-center justify-center px-4 py-2 rounded-full min-h-[36px] flex-shrink-0',
                  'text-[10.5px] font-bold uppercase tracking-[0.06em] font-tight',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  'motion-safe:transition-opacity motion-safe:duration-150',
                  disabled ? 'bg-ink/5 text-faint cursor-not-allowed' : 'bg-ink text-bg hover:opacity-90 cursor-pointer',
                ].join(' ')}
              >
                {locked ? 'Done' : weeklyCapped ? 'Limit reached' : 'Build'}
              </button>
            </div>
          </div>
        );
      })}

      {openSbc && (
        <SbcPicker
          sbc={openSbc}
          owned={owned}
          onClose={() => setOpenKey(null)}
          onSubmit={async (cards) => {
            await onSubmit(openSbc.key, cards);
            setOpenKey(null);
          }}
          submitting={submitting && submittingKey === openSbc.key}
        />
      )}
    </div>
  );
}

function SbcPicker({
  sbc,
  owned,
  onClose,
  onSubmit,
  submitting,
}: {
  sbc: Sbc;
  owned: OwnedCard[];
  onClose: () => void;
  onSubmit: (cards: { playerId: string; teamSlug: string; year: number }[]) => Promise<void>;
  submitting: boolean;
}) {
  // One entry per selected COPY — the same card can appear more than once, up
  // to how many copies the user owns (utcg_sbc_submit takes one array element
  // per copy handed in).
  const [selected, setSelected] = useState<UtcgCard[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selectedCountByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of selected) m.set(cardKeyOf(c), (m.get(cardKeyOf(c)) ?? 0) + 1);
    return m;
  }, [selected]);

  const met = useMemo(() => sbcMet(sbc.requirements, selected), [sbc.requirements, selected]);
  const avgScore = selected.length > 0 ? selected.reduce((s, c) => s + c.playerScore, 0) / selected.length : 0;

  const toggle = (o: OwnedCard) => {
    const key = cardKeyOf(o.card);
    const have = selectedCountByKey.get(key) ?? 0;
    if (have > 0) {
      // Remove one instance.
      const idx = selected.findIndex((c) => cardKeyOf(c) === key);
      setSelected((prev) => prev.filter((_, i) => i !== idx));
      return;
    }
    if (selected.length >= sbc.requirements.count) return;
    setSelected((prev) => [...prev, o.card]);
  };

  const addAnother = (o: OwnedCard) => {
    const key = cardKeyOf(o.card);
    const have = selectedCountByKey.get(key) ?? 0;
    if (have >= o.copies || selected.length >= sbc.requirements.count) return;
    setSelected((prev) => [...prev, o.card]);
  };

  const sorted = useMemo(() => [...owned].sort((a, b) => b.card.playerScore - a.card.playerScore), [owned]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 motion-safe:animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Build ${sbc.name}`}
        className="relative z-10 w-full sm:max-w-2xl bg-bg rounded-t-card-lg sm:rounded-card-lg shadow-hero max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-hairline flex-shrink-0">
          <div>
            <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-accent font-tight mb-0.5">
              {selected.length}/{sbc.requirements.count} selected{selected.length > 0 ? ` · avg ${avgScore.toFixed(0)}` : ''}
            </p>
            <h3 className="font-display italic text-xl font-bold text-ink leading-none">{sbc.name}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-full flex items-center justify-center text-faint hover:text-ink hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-safe:transition-colors motion-safe:duration-150 cursor-pointer flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 2l10 10M12 2l-10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {selected.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-4 py-3 border-b border-hairline flex-shrink-0">
            {selected.map((c, i) => (
              <button
                key={`${cardKeyOf(c)}-${i}`}
                type="button"
                onClick={() => setSelected((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove ${c.name} from selection`}
                className="w-16 flex-shrink-0 cursor-pointer"
              >
                <CardTile card={c} compact selected />
              </button>
            ))}
          </div>
        )}

        <div className="overflow-y-auto p-4">
          <p className="text-[9px] font-extrabold tracking-[0.14em] uppercase text-faint mb-3">
            Your collection · tap to add, tap again to remove one copy
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {sorted.map((o) => {
              const key = cardKeyOf(o.card);
              const have = selectedCountByKey.get(key) ?? 0;
              const canAddMore = have < o.copies && selected.length < sbc.requirements.count;
              return (
                <div key={key} className="relative">
                  <CardTile
                    card={o.card}
                    copies={o.copies}
                    untradeable={o.untradeable}
                    selected={have > 0}
                    onClick={() => toggle(o)}
                  />
                  {have > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-white flex items-center justify-center text-[9px] font-extrabold tabular leading-none shadow-soft">
                      {have}
                    </span>
                  )}
                  {have > 0 && canAddMore && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); addAnother(o); }}
                      aria-label={`Add another copy of ${o.card.name}`}
                      className="absolute bottom-1.5 right-1.5 w-7 h-7 rounded-full bg-ink/80 text-white flex items-center justify-center text-sm font-bold cursor-pointer hover:bg-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      +
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="p-4 border-t border-hairline flex-shrink-0">
          <button
            type="button"
            onClick={() => onSubmit(selected.map((c) => ({ playerId: c.playerId, teamSlug: c.teamSlug, year: c.year })))}
            disabled={!met || submitting}
            className={[
              'w-full inline-flex items-center justify-center px-6 py-3.5 rounded-full min-h-[48px]',
              'text-[12px] font-bold tracking-[0.12em] uppercase font-tight',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              'motion-safe:transition-opacity motion-safe:duration-150',
              met && !submitting ? 'bg-accent text-accent-ink hover:opacity-90 cursor-pointer' : 'bg-ink/5 text-faint cursor-not-allowed',
            ].join(' ')}
          >
            {submitting ? 'Submitting…' : met ? `Submit for ${rewardLabel(sbc.rewardPack)}` : `Needs ${sbc.requirements.count - selected.length} more / requirements not met`}
          </button>
          <p className="text-[10px] text-faint font-tight text-center mt-2">
            Handed-in cards are consumed — reward (untradeable) copies are used first.
          </p>
        </div>
      </div>
    </div>
  );
}
