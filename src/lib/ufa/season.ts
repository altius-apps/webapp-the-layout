// Pure season helpers — no server-only dependency, safe to import in client components.

import { defaultSeason } from '@/lib/season-windows';

/** Current UFA season year. Season runs ~April through August; the default
 *  flips to the new year on February 1 (season-windows.ts). */
export function currentSeasonYear(now: Date = new Date()): number {
  return defaultSeason('ufa', now);
}

/** Default years dropdown — most recent down through 2022 (UFA rebrand window). */
export function recentSeasons(n: number = 5): number[] {
  const cur = currentSeasonYear();
  return Array.from({ length: n }, (_, i) => cur - i);
}

// Seasons each franchise actually played, derived 2026-08-06 by walking the
// UFA games API (games?years=Y) for 2012–2026 and collecting home/away
// teamIDs. The API keys ALL history under a franchise's CURRENT slug — Dallas
// 2016–2021 (Roughnecks era) is `legion` — so one slug covers a franchise's
// whole run. 2020 is absent everywhere (COVID; the league played no games).
// Refresh by re-running the walk when a season is added; append-only data.
const SEASONS_BY_TEAM: Record<string, readonly number[]> = {
  alleycats:     [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  apex:          [2022, 2023, 2024, 2025, 2026],
  aviators:      [2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025],
  bighorns:      [2025, 2026],
  breeze:        [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  cannons:       [2015, 2016, 2017, 2018, 2019, 2021, 2022],
  cascades:      [2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  constitution:  [2012],
  cranes:        [2012],
  dragons:       [2012, 2013, 2014, 2015],
  empire:        [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  express:       [2015, 2016],
  flamethrowers: [2014, 2015, 2016, 2017, 2018],
  flyers:        [2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  glory:         [2021, 2022, 2023, 2024, 2025, 2026],
  growlers:      [2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  hammerheads:   [2013],
  havoc:         [2023, 2024, 2025, 2026],
  hustle:        [2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  legion:        [2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024],
  lions:         [2014],
  mechanix:      [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025],
  nightwatch:    [2015, 2016, 2017, 2018],
  outlaws:       [2015, 2016, 2017, 2018, 2019, 2021, 2022],
  phoenix:       [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  radicals:      [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  rampage:       [2012],
  revolution:    [2012, 2013, 2014, 2015, 2016],
  riptide:       [2014, 2015, 2016, 2017],
  royal:         [2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  rush:          [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  shred:         [2022, 2023, 2024, 2025, 2026],
  sol:           [2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  spiders:       [2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  spinners:      [2012],
  steel:         [2022, 2023, 2024, 2025, 2026],
  thunderbirds:  [2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  union:         [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
  windchill:     [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026],
};

/**
 * Selectable seasons for a team's detail page, newest first — the years the
 * franchise actually fielded a team (so Legion offers 2024…2016, not an empty
 * 2026). Unknown slug → recentSeasons(5), the previous behavior.
 */
export function teamSeasons(teamID: string): number[] {
  const ys = SEASONS_BY_TEAM[teamID.toLowerCase()];
  return ys ? [...ys].sort((a, b) => b - a) : recentSeasons(5);
}
