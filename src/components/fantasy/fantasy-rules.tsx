// Fantasy rules + scoring content. Presentational Server Component (reads the
// SCORING constant only).
//
// The rules live in a modal (see FantasyRulesModal); this file exposes only
// the *content* (`FantasyRulesContent`), with no card chrome.

import { SCORING } from '@/lib/fantasy/scoring';
import { EVENT_SCORING, placementBonus } from '@/lib/fantasy/event-adapter';
import { ratingExplainer } from '@/lib/fantasy/ratings';
import type { CompetitionId, ContestMode, FantasyPlayerLeague } from '@/lib/fantasy/competitions';

const SCORING_ROWS: { stat: string; off: string; def: string; neg: boolean }[] = [
  { stat: 'Goal', off: `+${SCORING.offender.goal}`, def: `+${SCORING.defender.goal}`, neg: false },
  { stat: 'Assist', off: `+${SCORING.offender.assist}`, def: `+${SCORING.defender.assist}`, neg: false },
  { stat: 'Block', off: `+${SCORING.offender.block}`, def: `+${SCORING.defender.block}`, neg: false },
  { stat: 'Callahan', off: `+${SCORING.offender.callahan}`, def: `+${SCORING.defender.callahan}`, neg: false },
  { stat: 'Turnover', off: `${SCORING.offender.turnover}`, def: `${SCORING.defender.turnover}`, neg: true },
  { stat: 'Yards (per 100)', off: '+1', def: '+1', neg: false },
];

/**
 * The rules body — heading, explainer, and scoring table. No outer card; the
 * caller (inline card or modal) supplies the surrounding chrome. `headingId`
 * lets the container wire aria-labelledby to the heading. `mode='event'`
 * swaps in the event-contest rules (flex roster, event totals + placement
 * bonus — see event-adapter.ts), which share nothing with the weekly matrix.
 */
export function FantasyRulesContent({
  headingId,
  mode = 'weekly-stats',
  playerLeague,
  competition,
}: {
  headingId?: string;
  mode?: ContestMode;
  playerLeague?: FantasyPlayerLeague;
  /** Picks the club vs college wording of the event player-ranking section. */
  competition?: CompetitionId;
}) {
  if (mode === 'event') {
    return <EventRulesContent headingId={headingId} playerLeague={playerLeague} competition={competition} />;
  }
  // PUL doesn't record callahans; WUL's are held out until the data is checked.
  const rows =
    playerLeague === 'pul' || playerLeague === 'wul' ? SCORING_ROWS.filter((r) => r.stat !== 'Callahan') : SCORING_ROWS;
  return (
    <>
      <div className="mb-5">
        <h2
          id={headingId}
          className="font-display italic text-[22px] lg:text-[28px] font-bold tracking-[-0.02em] text-ink leading-[0.95] mb-2"
        >
          Build your roster.
          <br className="hidden sm:block" /> Compete against your league.
        </h2>
        <p className="text-muted font-tight text-[14px] lg:text-[15px] leading-relaxed max-w-[560px]">
          Your team is 12 players: 7 start each week (4 offense + 3 defense) and the other 5 sit on the bench. The role you assign each
          player skews how their stats score — a defender&apos;s block pays{' '}
          <span className="text-ink font-semibold">{SCORING.defender.block} pts</span> vs{' '}
          <span className="text-ink font-semibold">{SCORING.offender.block} pts</span> as an
          offender, and an offender&apos;s assist pays{' '}
          <span className="text-ink font-semibold">{SCORING.offender.assist} pts</span> vs{' '}
          <span className="text-ink font-semibold">{SCORING.defender.assist} pts</span>. Your lineup locks when each scoring period&apos;s first game starts, so set
          it before kickoff.
        </p>
      </div>

      {/* Scoring table */}
      <div>
        <div className="text-[11px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-3">
          Scoring
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[320px]" aria-label="Fantasy scoring table">
            <thead>
              <tr>
                <th scope="col" className="pb-2 pr-6 text-[11px] font-bold tracking-[0.14em] uppercase text-faint font-tight">
                  Stat
                </th>
                <th scope="col" className="pb-2 pr-6 text-[11px] font-bold tracking-[0.14em] uppercase text-faint font-tight text-right">
                  Offender
                </th>
                <th scope="col" className="pb-2 text-[11px] font-bold tracking-[0.14em] uppercase text-faint font-tight text-right">
                  Defender
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.stat} className="border-t border-hairline">
                  <td className="py-2.5 pr-6 font-tight text-[13px] font-medium text-ink">{row.stat}</td>
                  <td
                    className={[
                      'py-2.5 pr-6 font-tight text-[13px] font-bold tabular text-right',
                      row.neg ? 'text-live' : 'text-ink',
                    ].join(' ')}
                  >
                    {row.off}
                  </td>
                  <td
                    className={[
                      'py-2.5 font-tight text-[13px] font-bold tabular text-right',
                      row.neg ? 'text-live' : 'text-accent',
                    ].join(' ')}
                  >
                    {row.def}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-faint font-tight">
          Defender column in coral — defenders earn more per block. Points accumulate
          every scoring period.
        </p>
      </div>
    </>
  );
}

const PLACEMENT_ROWS: { label: string; place: number }[] = [
  { label: 'Champion', place: 1 },
  { label: 'Runner-up', place: 2 },
  { label: 'Semifinalist', place: 3 },
  { label: 'Quarterfinalist', place: 5 },
];

function EventRulesContent({
  headingId,
  playerLeague,
  competition,
}: {
  headingId?: string;
  playerLeague?: FantasyPlayerLeague;
  competition?: CompetitionId;
}) {
  // USAU and EUCS publish goals + assists only; WFDF also records callahans.
  const statRows = [
    { stat: 'Goal', pts: EVENT_SCORING.goal },
    { stat: 'Assist', pts: EVENT_SCORING.assist },
    ...(playerLeague === 'wfdf' ? [{ stat: 'Callahan', pts: EVENT_SCORING.callahan }] : []),
  ];
  // Only USAU nationals have a ranked player list. With no competition given,
  // a USAU (or unspecified) pool gets the club wording.
  const ranked = competition ?? (!playerLeague || playerLeague === 'usau' ? 'usau-club-nationals' : null);
  const showRanking = ranked === 'usau-club-nationals' || ranked === 'usau-college-nationals';
  return (
    <>
      <div className="mb-5">
        <h2
          id={headingId}
          className="font-display italic text-[22px] lg:text-[28px] font-bold tracking-[-0.02em] text-ink leading-[0.95] mb-2"
        >
          Draft the event.
          <br className="hidden sm:block" /> Score on the totals.
        </h2>
        <p className="text-muted font-tight text-[14px] lg:text-[15px] leading-relaxed max-w-[560px]">
          Draft a 7-player team from the event&apos;s rosters — no positions, no bench. Your team
          is set for the whole event: it locks when the event starts, and each player scores
          once from their event totals, plus a bonus for how far their team finishes.
        </p>
      </div>

      <div>
        <div className="text-[11px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-3">
          Scoring
        </div>
        <table className="w-full text-left border-collapse" aria-label="Event fantasy scoring table">
          <thead>
            <tr>
              <th scope="col" className="pb-2 pr-6 text-[11px] font-bold tracking-[0.14em] uppercase text-faint font-tight">
                Stat
              </th>
              <th scope="col" className="pb-2 text-[11px] font-bold tracking-[0.14em] uppercase text-faint font-tight text-right">
                Points
              </th>
            </tr>
          </thead>
          <tbody>
            {statRows.map((row) => (
              <tr key={row.stat} className="border-t border-hairline">
                <td className="py-2.5 pr-6 font-tight text-[13px] font-medium text-ink">{row.stat}</td>
                <td className="py-2.5 font-tight text-[13px] font-bold tabular text-right text-ink">+{row.pts}</td>
              </tr>
            ))}
            {PLACEMENT_ROWS.map((row) => (
              <tr key={row.label} className="border-t border-hairline">
                <td className="py-2.5 pr-6 font-tight text-[13px] font-medium text-ink">{row.label} team</td>
                <td className="py-2.5 font-tight text-[13px] font-bold tabular text-right text-accent">
                  +{placementBonus(row.place)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[11px] text-faint font-tight">
          Placement bonuses in coral go to every drafted player on that team.
        </p>
      </div>

      {showRanking && (
        <div className="mt-6">
          <div className="text-[11px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-3">
            How players are ranked
          </div>
          <ul className="space-y-2">
            {ratingExplainer(ranked).map((line) => (
              <li key={line} className="font-tight text-[13px] leading-snug text-muted">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
