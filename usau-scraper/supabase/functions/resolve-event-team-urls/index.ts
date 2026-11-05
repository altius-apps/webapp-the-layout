// resolve-event-team-urls: for each event, fetch its USAU schedule page,
// pull every EventTeamId href (base64 per-event id), match by team name
// against our usau_event_teams rows, and write usau_event_team_url_id.
//
// Why this exists: ingest-from-ultirzr populates usau_event_teams with
// the persistent NUMERIC team id (e.g. 39463). USAU's team-page URL
// (where rosters live) takes the base64 per-event id (e.g.
// "TrJn0gcQQr4O2+tAt35FJlI2q5fW8qROOFxvNWZKBtE="). They're different.
//
// Request body:
//   { season?: number,        // filter to one season
//     limit?: number,         // cap number of events processed (default 50)
//     skipResolved?: boolean, // skip events where ALL participations
//                             //   already have a url_id (default true)
//     slug?: string }         // process exactly one event by slug
//
// Idempotent: re-running won't overwrite existing values. Polite: 2s
// between USAU fetches via the shared http helper.

import { fetchHtml } from '../_shared/http.ts';
import {
  BASE_URL,
  eventScheduleUrlVariants,
  extractTeamNameAndSeed,
  type ScheduleUrlLevel,
} from '../_shared/parse.ts';
import { supabase, withRunLogging } from '../_shared/supabase.ts';

interface RequestBody {
  season?: number;
  limit?: number;
  skipResolved?: boolean;
  slug?: string;
  /** Process only this gender bucket. Large multi-division events exceed the
   *  150s wall clock in one call (each gender tries several slug × url
   *  variants at 2s a fetch), so an operator can split them one gender per
   *  call. 'unknown' targets the teams whose usau_teams.gender_division is
   *  NULL — on some events that's the majority, and they're the slowest
   *  because they're attempted under every gender. */
  gender?: 'Men' | 'Women' | 'Mixed' | 'unknown';
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    return [o.message, o.code && `(${o.code})`, o.details && `— ${o.details}`]
      .filter(Boolean)
      .join(' ') || JSON.stringify(err);
  }
  return String(err);
}

/** Parse every EventTeamId link out of a schedule page's HTML, returning a
 *  map of normalized team name → base64 url id. Same team can appear
 *  multiple times in bracket/pool blocks; we keep the first occurrence. */
function extractEventTeamIdsByName(html: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match <a href="...EventTeamId=XXX...">Team Name (3)</a>
  const re = /<a[^>]*href="[^"]*EventTeamId=([^"&]+)[^"]*"[^>]*>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const urlId = decodeURIComponent(m[1]);
    const { name } = extractTeamNameAndSeed(m[2]);
    // Collapse whitespace like the lookup side does ("Burnside  40" on USAU's
    // page never matched our "burnside 40" key).
    const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key) continue;
    if (!map.has(key)) map.set(key, urlId);
  }
  return map;
}

/** Every EventTeamId linked on the page, duplicates of one name included. */
function extractEventTeamIds(html: string): Set<string> {
  const ids = new Set<string>();
  const re = /<a[^>]*href="[^"]*EventTeamId=([^"&]+)[^"]*"[^>]*>[^<]+<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) ids.add(decodeURIComponent(m[1]));
  return ids;
}

/** Team name → the seed printed beside it ("North Carolina (1)"), same keys as
 *  extractEventTeamIdsByName. First seeded occurrence wins. */
function extractSeedsByName(html: string): Map<string, number> {
  const map = new Map<string, number>();
  const re = /<a[^>]*href="[^"]*EventTeamId=[^"&]+[^"]*"[^>]*>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const { name, seed } = extractTeamNameAndSeed(m[1]);
    const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (key && seed != null && !map.has(key)) map.set(key, seed);
  }
  return map;
}

/** A year-less page can hold any season of a recurring tournament; accept it
 *  only when the seeds it prints agree with this event's stored seeds. Seeds
 *  reshuffle every season (2014 vs 2015 Atlantic Coast D-I men: 13 of 16 moved),
 *  so ≥4 comparable teams at ≥80% agreement is a season fingerprint. */
function seedsAgree(pageSeeds: Map<string, number>, ours: Array<{ key: string; seed: number | null }>): { ok: boolean; compared: number; agreed: number } {
  let compared = 0;
  let agreed = 0;
  for (const o of ours) {
    if (o.seed == null) continue;
    const s = pageSeeds.get(o.key);
    if (s == null) continue;
    compared++;
    if (s === o.seed) agreed++;
  }
  return { ok: compared >= 4 && agreed / compared >= 0.8, compared, agreed };
}

/** Generate plausible slug variants. ultirzr sometimes derives slugs in
 *  ways that don't match USAU's URL (e.g. "Men's" → "men-s" instead of
 *  "mens"). Try the primary first, then fall through alternates. */
function slugVariants(slug: string, allowYearStrip = false, season?: number | null): string[] {
  const variants = new Set<string>();
  const forms = [
    slug,
    slug.replace(/-s-/g, 's-'),                  // men-s-regional → mens-regional
    slug.replace(/-s$/, 's'),                     // …-men-s → …-mens
    slug.replace(/-s-/g, 's-').replace(/-s$/, 's'),
  ];
  for (const f of forms) variants.add(f);
  // ultirzr names some events by CONCATENATING the tournament with its host or
  // co-located event ("TCT Elite Select Challenge 2023 Indy Invite"), so our
  // slug carries a trailing suffix USAU's url doesn't have and the event
  // resolves zero team urls. Truncating everything AFTER an interior year
  // recovers it: tct-elite-select-challenge-2023-indy-invite →
  // tct-elite-select-challenge-2023 (verified 2026-09-09: 200 with all 16 Men's
  // teams matching our rows exactly; same for the 2022 edition).
  //
  // Unlike the year-STRIP below this needs no gate — it KEEPS the year, so it
  // can never resolve to a different season's page. Requiring an interior year
  // (something before it, something after it) also means a year-leading slug
  // like "2023-u-s-open-club-championships-icc" is left alone rather than
  // truncated to a bare "2023".
  for (const f of forms) {
    const m = f.match(/^(.+-(?:19|20)\d{2})-.+$/);
    if (m) variants.add(m[1]);
  }
  // The INVERSE of the year-strip below: our slug is year-less but USAU's url
  // carries a trailing year. Club Series events 2016 and 2018 are stored this
  // way (ingest took the bare event name), so every fetch 404s and the event
  // resolves zero team urls — 791 teams in 2018, 57 in 2016.
  // Verified 2026-09-14: founders-mens-sectional-championship-2018,
  // northeast-mens-regional-championship-2018, nor-cal-mixed-…-2018,
  // south-central-mens-regionals-2016 and northwest-plains-mens-sectionals-2016
  // all 200 under this rule while the stored year-less form 404s.
  //
  // Needs no gate: it ADDS the event's own season, so it can never resolve to a
  // different season's page (the danger the year-strip guards against). Only
  // applied to a slug that has no year at either end, so a year-leading or
  // year-trailing slug is left alone.
  if (season) {
    for (const f of forms) {
      if (/^(19|20)\d{2}-/.test(f) || /-(19|20)\d{2}$/.test(f)) continue;
      variants.add(`${f}-${season}`);
    }
  }
  // USAU serves many recurring tournaments at a YEAR-LESS url — our slug
  // carries the year (from ultirzr or a year-disambiguated ingest), so the
  // year-suffixed url 404s and the event resolves zero team urls.
  //
  // DANGEROUS without the caller's gate: USAU keeps ONE page per recurring
  // tournament name, and it holds whichever season we happened to ingest under
  // the bare slug. Verified 2026-09-07: /events/heavyweights/ lists our 2014
  // event's teams (8/8 matched 2014, not 2018), so stripping the year on
  // heavyweights-2018 would write 2014 rosters onto 2018 teams. Only the
  // caller can tell the difference — it checks for a year-less twin event in
  // the DB — so this variant is opt-in, never automatic.
  if (allowYearStrip) {
    for (const f of forms) variants.add(f.replace(/-(19|20)\d{2}$/, ''));
  }
  return Array.from(variants);
}

async function resolveOneEvent(
  db: ReturnType<typeof supabase>,
  eventUuid: string,
  slug: string,
  competitionLevel: string | null,
  onlyGender?: RequestBody['gender'],
  season?: number | null,
  name?: string | null,
): Promise<{ resolved: number; skipped: number; error?: string; usedSlug?: string }> {
  // Masters events need masters URL segments, and one combined event (the
  // Masters Championships) hosts Masters + Grand Masters + Great Grand
  // Masters divisions under a single slug — so for masters we try the whole
  // segment family per gender and merge whatever resolves. Order the family
  // by what the slug hints at so single-division regionals usually hit on
  // the first fetch.
  const isMastersEvent =
    competitionLevel === 'MASTERS' ||
    competitionLevel === 'GRAND_MASTERS' ||
    competitionLevel === 'GREAT_GRAND_MASTERS';

  // Year-strip gate. Our slug may carry a year USAU's url doesn't use, in
  // which case the year-suffixed page 404s and this event resolves nothing.
  // Stripping is only SAFE when no other event already owns the bare slug: if
  // one does, USAU's single page for that tournament holds THAT season, and
  // scraping it here would attribute another year's teams to this event.
  //
  // TWO ways the bare slug can belong to a season that isn't ours, and both
  // must block:
  //   (a) another event already HOLDS the year-less slug (e.g. 2014 owns
  //       "heavyweights", so heavyweights-2018 must not scrape it); and
  //   (b) SIBLINGS share the base — "usa-ultimate-national-championships"
  //       exists for 2014/15/16/17/18/21, and USAU serves ONE page for that
  //       name. No row holds the bare slug, so check (a) passes, but the page
  //       can only be one of those seasons. This is the year-less collision
  //       that merged 5 Nationals + 740 games into one event. A stripped page
  //       with siblings is only accepted when its seeds match this event's
  //       (seedsAgree) — USAU keeps the FIRST edition at the bare url, e.g.
  //       atlantic-coast-d-i-college-mens-regionals = 2014 (verified 09-29).
  const stripped = slug.replace(/-(19|20)\d{2}$/, '');
  let allowYearStrip = false;
  let hasSibling = false;
  if (stripped !== slug) {
    const { data: twin } = await db
      .from('usau_events')
      .select('id')
      .ilike('usau_slug', stripped)
      .neq('id', eventUuid)
      .limit(1);
    const holdsBare = !!twin && twin.length > 0;

    const { data: siblings } = await db
      .from('usau_events')
      .select('id')
      .ilike('usau_slug', `${stripped}-%`)
      .neq('id', eventUuid)
      .limit(1);
    hasSibling = !!siblings && siblings.length > 0;

    allowYearStrip = !holdsBare;
    if (!allowYearStrip) {
      console.log(`[resolver] ${slug}: year-strip blocked — "${stripped}": another event holds it`);
    }
  }

  // National championships were "USA Ultimate D-I College Championships" on
  // USAU while ultirzr dropped the prefix ("d-i-college-championships-2014"),
  // so every fetch 404'd; the 2014 editions live at the prefixed, year-less
  // url. Fetch-only, and year-less forms still go through seedsAgree.
  const tryUsauPrefix =
    !!name &&
    /(college|club|national|masters) championships/i.test(name) &&
    !/regional|sectional|conference/i.test(name) &&
    !/^usa-ultimate-/i.test(slug);

  // USAU builds an event's slug from its NAME: every whitespace char becomes
  // '-' (runs are NOT collapsed, and a trailing space leaves a trailing '-')
  // and every other char outside [A-Za-z0-9-] is dropped, so "Great
  // Lakes/Southeast" → "Great-LakesSoutheast". ingest-from-ultirzr synthesized
  // the 2022-2025 masters regionals slugs with a different rule (collapse runs,
  // '/' → '-', trim), so every URL 404'd: 81 events / 472 teams never resolved.
  // Club/college hit the same thing on punctuated names (TCT "Invite - West"
  // → "Invite---West", "PB&J" → "PBJ", trailing-space names → trailing '-').
  // Only when the name carries this event's own season, so the page can't be
  // another season's; skipped when another event already owns that slug.
  let nameSlug: string | null = null;
  if (name && season && new RegExp(`\\b${season}\\b`).test(name)) {
    const candidate = name.replace(/\s/g, '-').replace(/[^A-Za-z0-9-]/g, '');
    if (candidate && candidate.toLowerCase() !== slug.toLowerCase()) {
      const { data: owner, error: ownerErr } = await db
        .from('usau_events')
        .select('id')
        .ilike('usau_slug', candidate)
        .neq('id', eventUuid)
        .limit(1);
      if (!ownerErr && (!owner || owner.length === 0)) nameSlug = candidate;
    }
  }

  const slugLower = slug.toLowerCase();
  const levelSegments: ScheduleUrlLevel[] = isMastersEvent
    ? slugLower.includes('great-grand')
      ? ['Great-Grand-Masters', 'Grand-Masters', 'Masters']
      : slugLower.includes('grand')
        ? ['Grand-Masters', 'Great-Grand-Masters', 'Masters']
        : ['Masters', 'Grand-Masters', 'Great-Grand-Masters']
    : [competitionLevel?.startsWith('COLLEGE') ? 'College' : 'Club'];

  // Load all unresolved participations + each team's gender_division.
  // A single event can host multiple genders (e.g. Nationals has Men's,
  // Women's, Mixed divisions all under one event_id) — we need to try
  // each gender's schedule URL separately.
  const { data: parts, error: loadErr } = await db
    .from('usau_event_teams')
    .select('team_id, seed, usau_event_team_id, usau_teams(name, gender_division)')
    .eq('event_id', eventUuid)
    .is('usau_event_team_url_id', null);
  if (loadErr) {
    return { resolved: 0, skipped: 0, error: `load participations: ${stringifyErr(loadErr)}` };
  }

  type Part = {
    team_id: string;
    seed: number | null;
    usau_event_team_id: string | null;
    usau_teams: { name: string; gender_division: string | null } | null;
  };
  const partsByGender = new Map<string, Part[]>();
  for (const p of (parts ?? []) as unknown as Part[]) {
    const raw = p.usau_teams?.gender_division ?? null;
    // `onlyGender` lets an operator split an event that can't finish inside
    // the 150s wall clock. 'unknown' selects the NULL-gender teams, which
    // default into the 'Men' bucket below but are the expensive ones (no
    // division to aim at, so every variant gets tried).
    if (onlyGender) {
      const matches = onlyGender === 'unknown' ? raw === null : raw === onlyGender;
      if (!matches) continue;
    }
    const g = raw ?? 'Men';
    if (!partsByGender.has(g)) partsByGender.set(g, []);
    partsByGender.get(g)!.push(p);
  }
  // Make sure 'Men' is tried first for slug-detection so the canonical
  // updated slug (if we discover a working variant) gets persisted from
  // the most common case.
  const genderOrder = (['Men', 'Women', 'Mixed', 'Open'] as const).filter((g) => partsByGender.has(g));
  if (genderOrder.length === 0) return { resolved: 0, skipped: 0 };

  let totalResolved = 0;
  let totalSkipped = 0;
  let lastUsedSlug: string | null = null;

  for (const gender of genderOrder) {
    const genderParts = partsByGender.get(gender) ?? [];
    if (genderParts.length === 0) continue;

    // Map "Mixed/Open" → gender code USAU uses in its URL. USAU's college
    // pages use "Men" / "Women", club pages use "Men"/"Women"/"Mixed".
    const urlGender: 'Men' | 'Women' | 'Mixed' =
      gender === 'Women' ? 'Women' : gender === 'Mixed' ? 'Mixed' : 'Men';

    // Wanted lookup keys for this gender — lets us stop fetching further
    // masters level segments once every team is already covered.
    const wantedKeys = genderParts
      .map((p) => p.usau_teams?.name?.toLowerCase().replace(/\s+/g, ' ').trim())
      .filter((k): k is string => !!k);

    const byName = new Map<string, string>();
    const pageIds = new Set<string>();
    let usedSlug: string | null = null;
    // The name-derived slug is a fetch path only — never our identity (see the
    // persist guard below).
    let fromName = false;

    for (const seg of levelSegments) {
      let html: string | null = null;
      // Masters: the stored slug is the synthesized one that never matches, so
      // the name form goes first. Club/college stored slugs usually do match,
      // so it goes right after the stored slug's exact forms but BEFORE the
      // truncation / year-append / year-strip guesses: those can land on a
      // different event's page (a truncated "new-york-warm-up-2018" is the main
      // NYWU, not its sanctioned side event); nameSlug is owner-checked.
      const base = usedSlug ?? slug;
      // The year-strip gate was checked against the stored slug, not nameSlug.
      const variants = slugVariants(base, fromName ? false : allowYearStrip, season);
      const exactForms = new Set([
        base,
        base.replace(/-s-/g, 's-'),
        base.replace(/-s$/, 's'),
        base.replace(/-s-/g, 's-').replace(/-s$/, 's'),
      ]);
      const ordered: string[] = [];
      if (nameSlug && !usedSlug && isMastersEvent) ordered.push(nameSlug);
      ordered.push(...variants.filter((v) => exactForms.has(v)));
      if (nameSlug && !usedSlug && !isMastersEvent) ordered.push(nameSlug);
      ordered.push(...variants.filter((v) => !exactForms.has(v)));
      if (tryUsauPrefix && !usedSlug) {
        ordered.push(`usa-ultimate-${slug}`);
        if (allowYearStrip && stripped !== slug) ordered.push(`usa-ultimate-${stripped}`);
      }
      // USAU slugs are case-insensitive: "2023-Mens-…" is the same page as an
      // already-404'd "2023-mens-…" form, so dedupe on the lowercased slug.
      const seenLower = new Set<string>();
      const candidates = ordered.filter((c) => {
        const k = c.toLowerCase();
        if (seenLower.has(k)) return false;
        seenLower.add(k);
        return true;
      });
      outer: for (const candidate of candidates) {
        for (const url of eventScheduleUrlVariants(candidate, urlGender, seg)) {
          try {
            html = await fetchHtml(url);
            usedSlug = candidate;
            if (candidate === nameSlug) fromName = true;
            break outer;
          } catch (err) {
            const msg = stringifyErr(err);
            // 404 is EXPECTED here: single-division masters events only have
            // one level segment; the wrong-level candidates just miss.
            if (/HTTP 404/.test(msg) || /404 /.test(msg)) continue;
            // Non-404 = real error; bubble out
            return { resolved: totalResolved, skipped: totalSkipped, error: msg };
          }
        }
      }
      // A page that drops our season's year must prove it's this season.
      if (html && usedSlug && /-(19|20)\d{2}$/.test(slug) && !/(19|20)\d{2}/.test(usedSlug)) {
        const { data: owner } = await db
          .from('usau_events')
          .select('id')
          .ilike('usau_slug', usedSlug)
          .neq('id', eventUuid)
          .limit(1);
        let why: string | null = owner && owner.length > 0 ? 'another event holds it' : null;
        if (!why && (hasSibling || usedSlug.toLowerCase() !== stripped.toLowerCase())) {
          const ours = genderParts.map((p) => ({
            key: (p.usau_teams?.name ?? '').toLowerCase().replace(/\s+/g, ' ').trim(),
            seed: p.seed,
          }));
          const v = seedsAgree(extractSeedsByName(html), ours);
          if (!v.ok) why = `seeds ${v.agreed}/${v.compared} match`;
        }
        if (why) {
          console.log(`[resolver] ${slug} ${gender}: rejected year-less page "${usedSlug}" — ${why}`);
          html = null;
          usedSlug = null;
        }
      }
      // 2021 College Championships nests each division one level deeper
      // (/schedule/men/collegemen/d_i_men/), so every standard url 404s.
      if (!html && seg === 'College') {
        for (const sub of ['d_i', 'd_iii']) {
          const g = urlGender.toLowerCase();
          const url = `${BASE_URL}/events/${slug}/schedule/${g}/college${g}/${sub}_${g}/`;
          try {
            html = await fetchHtml(url);
            usedSlug = slug;
            break;
          } catch (err) {
            const msg = stringifyErr(err);
            if (/HTTP 404/.test(msg) || /404 /.test(msg)) continue;
            return { resolved: totalResolved, skipped: totalSkipped, error: msg };
          }
        }
      }
      if (html) {
        for (const [k, v] of extractEventTeamIdsByName(html)) {
          if (!byName.has(k)) byName.set(k, v);
        }
        for (const id of extractEventTeamIds(html)) pageIds.add(id);
      }
      // Non-masters events have exactly one segment; masters events can stop
      // early once every wanted team has been seen on some level's page.
      if (!isMastersEvent) break;
      if (byName.size > 0 && wantedKeys.every((k) => byName.has(k))) break;
    }

    if (!usedSlug || byName.size === 0) {
      // No schedule page (or an empty one) for this gender — count as skipped.
      totalSkipped += genderParts.length;
      continue;
    }

    // Persist the working slug only once if it changed — but NEVER persist a
    // year-stripped one. usau_slug is the public identity (the
    // /usau/events/[slug] route key and the favorites key), and the year-less
    // form is typically already owned by another season's event (USAU reuses
    // one page per recurring tournament). Rewriting to it would 404 live links,
    // orphan saved favorites, and undo the year-disambiguation that
    // ingest-from-ultirzr adds to keep seasons apart. Fetching from it is fine;
    // adopting it as our identity is not.
    const isYearStripped = usedSlug === slug.replace(/-(19|20)\d{2}$/, '') && usedSlug !== slug;
    // Same reasoning for the suffix-truncated variant: it's a fetch path, not
    // our identity. usau_slug is already published in links and favorites, so
    // adopting the shortened form would 404 them.
    const isSuffixTruncated = usedSlug !== slug && slug.startsWith(`${usedSlug}-`);
    // Same for the year-APPENDED variant (2016/2018 Club Series): USAU serves
    // the page at "<our slug>-<season>", but our year-less slug is the published
    // identity. Fetching from the year-suffixed url is fine; adopting it is not.
    //
    // Compare against the year-appended form of EVERY slug form, not just the
    // raw slug: the winning candidate is usually ALSO `-s-`-collapsed
    // (founders-men-s-… → founders-mens-…-2018), so a bare
    // `usedSlug === slug-season` check never matches and the rewrite escapes.
    const isYearAppended =
      usedSlug !== slug &&
      !!season &&
      [
        slug,
        slug.replace(/-s-/g, 's-'),
        slug.replace(/-s$/, 's'),
        slug.replace(/-s-/g, 's-').replace(/-s$/, 's'),
      ].some((f) => usedSlug === `${f}-${season}`);
    // Same for the name-derived slug: usau_slug stays the public route key.
    // And for any page that dropped our year or borrowed the usa-ultimate-
    // prefix: seed-verified fetch paths, not identities.
    const isYearDropped = /-(19|20)\d{2}$/.test(slug) && !/(19|20)\d{2}/.test(usedSlug);
    const isPrefixed = /^usa-ultimate-/i.test(usedSlug) && !/^usa-ultimate-/i.test(slug);
    if (usedSlug !== slug && !isYearStripped && !isSuffixTruncated && !isYearAppended && !fromName && !isYearDropped && !isPrefixed) {
      const { error: updErr } = await db
        .from('usau_events')
        .update({ usau_slug: usedSlug })
        .eq('id', eventUuid);
      if (updErr) {
        console.error(`[resolver] failed to update slug ${slug} → ${usedSlug}: ${stringifyErr(updErr)}`);
      } else {
        // Report only a slug that became usau_slug: callers (sync-event-everything)
        // pass perEvent[].slug on to sync-event-rosters, which looks it up by
        // usau_slug — a fetch-only variant would not be found.
        lastUsedSlug = usedSlug;
      }
    }

    for (const p of genderParts) {
      // HTML-scraped participations already store the page's EventTeamId (it
      // equalled the url id on all 8,919 resolved rows, 2026-11-05). Use it
      // when the page links it: a name match can't tell apart two squads USAU
      // lists under one name (NY Minute 2026's two "Columbia University"; ours
      // is "Columbia University (B)"). ultirzr rows hold a numeric id, never on
      // the page, so they fall through to the name match.
      const idOnPage = p.usau_event_team_id && pageIds.has(p.usau_event_team_id)
        ? p.usau_event_team_id
        : null;
      const name = p.usau_teams?.name;
      if (!name) {
        totalSkipped++;
        continue;
      }
      const lookupKey = name.toLowerCase().replace(/\s+/g, ' ').trim();
      const urlId = idOnPage ?? byName.get(lookupKey);
      if (!urlId) {
        totalSkipped++;
        continue;
      }
      const { error: updErr } = await db
        .from('usau_event_teams')
        .update({ usau_event_team_url_id: urlId })
        .eq('event_id', eventUuid)
        .eq('team_id', p.team_id);
      if (updErr) {
        totalSkipped++;
        continue;
      }
      totalResolved++;
    }
  }

  return { resolved: totalResolved, skipped: totalSkipped, usedSlug: lastUsedSlug ?? undefined };
}

async function run(body: RequestBody) {
  const db = supabase();
  const limit = body.limit ?? 50;
  const skipResolved = body.skipResolved ?? true;

  // First, find every event-id that has at least one unresolved participation.
  // PostgREST doesn't do subqueries directly, so we ask for distinct event_ids
  // off usau_event_teams where url_id is null. That guarantees every event
  // we touch has real work to do.
  let unresolvedQuery = db
    .from('usau_event_teams')
    .select('event_id, usau_events!inner(id, usau_slug, name, season, competition_level, start_date)')
    .is('usau_event_team_url_id', null);
  if (body.season) unresolvedQuery = unresolvedQuery.eq('usau_events.season', body.season);
  if (body.slug) unresolvedQuery = unresolvedQuery.ilike('usau_events.usau_slug', body.slug);
  const { data: unresolvedRows, error } = await unresolvedQuery;
  if (error) throw new Error(`load events: ${stringifyErr(error)}`);

  type EventRow = {
    id: string;
    usau_slug: string;
    name: string | null;
    season: number;
    start_date: string | null;
    competition_level: string | null;
  };
  const seen = new Map<string, EventRow>();
  for (const row of unresolvedRows ?? []) {
    const ev = (row as { usau_events: EventRow | null }).usau_events;
    if (ev && !seen.has(ev.id)) seen.set(ev.id, ev);
  }
  // Sort newest first then take the limit.
  const events = Array.from(seen.values())
    .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))
    .slice(0, limit);

  if (events.length === 0) {
    return { rowsProcessed: 0, result: { events: 0, resolvedTotal: 0 } };
  }

  const perEvent: Array<{
    slug: string;
    season: number;
    resolved: number;
    skipped: number;
    error?: string;
  }> = [];

  for (const e of events) {
    // No need for the per-event count check anymore — we already filtered.
    if (!skipResolved) {
      // future: support force-rerun
    }
    const result = await resolveOneEvent(db, e.id, e.usau_slug, e.competition_level, body.gender, e.season, e.name);
    perEvent.push({
      slug: result.usedSlug ?? e.usau_slug,
      season: e.season,
      resolved: result.resolved,
      skipped: result.skipped,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  const resolvedTotal = perEvent.reduce((s, r) => s + r.resolved, 0);
  const skippedTotal = perEvent.reduce((s, r) => s + r.skipped, 0);

  return {
    rowsProcessed: resolvedTotal,
    result: {
      events: perEvent.length,
      resolvedTotal,
      skippedTotal,
      perEvent,
    },
  };
}

Deno.serve(async (req) => {
  let body: RequestBody = {};
  try {
    if (req.headers.get('content-type')?.includes('application/json')) {
      body = await req.json();
    } else {
      const url = new URL(req.url);
      if (url.searchParams.get('season')) body.season = parseInt(url.searchParams.get('season')!, 10);
      if (url.searchParams.get('limit')) body.limit = parseInt(url.searchParams.get('limit')!, 10);
      if (url.searchParams.get('slug')) body.slug = url.searchParams.get('slug')!;
      if (url.searchParams.get('gender')) body.gender = url.searchParams.get('gender')! as RequestBody['gender'];
    }
  } catch {
    // empty body OK
  }

  try {
    const res = await withRunLogging(
      'resolve-event-team-urls',
      body as Record<string, unknown>,
      () => run(body),
    );
    return Response.json({ ok: true, ...res });
  } catch (err) {
    const message = stringifyErr(err);
    console.error('[resolve-event-team-urls] failed:', message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});
