"""Backfill USAU bracket-sheet structure (bracket_stage / _index / _slot) onto
legacy usau_games rows from ultirzr's event JSON.

Usage: python3 -I backfill-bracket-structure.py <repo_root> <out_dir> [--apply]
         [--scope flighted|rest|all] [--limit N] [--gap S] [--slugs a,b] [--recompute]

Only writes the three structure columns, only on rows where bracket_stage_index
IS NULL. Never touches teams, names, scores or round. Every written row id is
recorded in usau_games_structure_backfill_20261019 for rollback. --recompute
re-derives the columns for rows already in that table (and only those).

Do NOT swap this for a re-run of ingest-from-ultirzr: that also upserts team
names, and ultirzr's "Rhino" would undo the 2026-10-09 Rhino Slam! merge.
"""
import json, os, re, ssl, sys, time, statistics, urllib.request, urllib.parse
from datetime import datetime
import certifi
import psycopg

SSL = ssl.create_default_context(cafile=certifi.where())

ROOT, OUT = sys.argv[1], sys.argv[2]
APPLY = '--apply' in sys.argv
SCOPE = sys.argv[sys.argv.index('--scope') + 1] if '--scope' in sys.argv else 'flighted'
LIMIT = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else None
GAP = float(sys.argv[sys.argv.index('--gap') + 1]) if '--gap' in sys.argv else 1.0
SLUGS = set(sys.argv[sys.argv.index('--slugs') + 1].split(',')) if '--slugs' in sys.argv else None
RECOMPUTE = '--recompute' in sys.argv
BASE = 'https://www.ultirzr.app/api/v1'
# Pool games ultirzr stored as round='other' (detect by name, like classifyRound).
POOL_RE = r'(^|·\s*)pool\M'
os.makedirs(OUT, exist_ok=True)
LOG = open(os.path.join(OUT, f"run-{SCOPE}-{'apply' if APPLY else 'dry'}.jsonl"), 'a')


def env():
    e = {}
    for line in open(os.path.join(ROOT, '.env')):
        m = re.match(r'^([A-Z_]+)=(.*)$', line.strip())
        if m:
            e[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return e


def connect():
    url = open(os.path.join(ROOT, 'usau-scraper/supabase/.temp/pooler-url')).read().strip()
    return psycopg.connect(url, password=env()['SUPABASE_DB_PASSWORD'], connect_timeout=15, autocommit=False)


def get(path):
    req = urllib.request.Request(BASE + path, headers={'User-Agent': 'the-layout-structure-backfill/1.0'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60, context=SSL) as r:
                return json.loads(r.read())
        except Exception as ex:  # transient ultirzr hiccup: back off, then give up on this event
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))


def norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def team_norm(s):
    return norm(re.sub(r'\s*\(\d+\)\s*$', '', s or ''))


def slot_of(name):
    m = re.match(r'^G\s*(\d+)$', (name or '').strip(), re.I)
    n = int(m.group(1)) if m else None
    return n if n is not None and 0 <= n <= 32767 else None


def when(gm):
    try:
        t = datetime.strptime(f"{gm.get('StartDate')} {gm.get('StartTime')}", '%m/%d/%Y %I:%M %p')
    except Exception:
        return None
    # Unscheduled games carry 01/01/0001, which .timestamp() can't take.
    return t if t.year >= 2000 else None


def winner(gm):
    try:
        a, b = int(gm.get('HomeTeamScore')), int(gm.get('AwayTeamScore'))
    except Exception:
        return None
    return gm.get('HomeTeamId') if a > b else gm.get('AwayTeamId') if b > a else None


def orientation(stages):
    """+1 when stages are final-first (index 0 = decider), -1 when reversed,
    0 when the data can't tell (single stage, no times, no results)."""
    if len(stages) < 2:
        return 0
    score = 0
    for i in range(len(stages) - 1):
        ti = [t for t in (when(g) for g in stages[i]) if t]
        tj = [t for t in (when(g) for g in stages[i + 1]) if t]
        if ti and tj:
            mi, mj = statistics.median([t.timestamp() for t in ti]), statistics.median([t.timestamp() for t in tj])
            score += 1 if mj < mi else -1 if mj > mi else 0
    if score != 0:
        return 1 if score > 0 else -1
    flow = 0
    for i in range(len(stages) - 1):
        in_i = {t for g in stages[i] for t in (g.get('HomeTeamId'), g.get('AwayTeamId')) if t}
        in_j = {t for g in stages[i + 1] for t in (g.get('HomeTeamId'), g.get('AwayTeamId')) if t}
        flow += sum(1 for g in stages[i + 1] if winner(g) in in_i)
        flow -= sum(1 for g in stages[i] if winner(g) in in_j)
    return 1 if flow > 0 else -1 if flow < 0 else 0


def strip_year(s):
    return norm(re.sub(r'\b(19|20)\d\d\b', ' ', s or ''))


def label_rank(name):
    """Round depth a column title names (0 = decider), or None if unclear.
    "Play-in" is not a depth: 2025 Nationals' "Pro Flight Play-In / 7th
    Place (tie)" is its section's decider."""
    t = (name or '').lower()
    if re.search(r'play.?in|cross|game.?to.?go|backdoor|consol', t):
        return None
    if 'semi' in t:
        return 1
    if re.search(r'pre.?(quart|quater|qtr)', t):
        return 3
    if re.search(r'quart|quater|qtr', t):
        return 2
    if re.search(r'final|champ', t):
        return 0
    return None


def stage_indexes(stages, names=None):
    """Column index per ultirzr stage, 0 = the deciding (last-played) column.
    ultirzr usually lists stages final-first, but some events list the final
    and then the other rounds oldest-first (Philly Invite 2018: Finals,
    Pre-Quarters, Quarters, Semis), so rank by when each stage was played;
    ties keep ultirzr's order. Untimed brackets fall back to orientation().
    Then USAU's own column titles win among the stages they name: ultirzr's
    times are sometimes wrong too (Riverside Classic 2019 lists its Final at
    10 AM, before the Pre-Quarters). Unnamed stages keep their place."""
    n = len(stages)
    meds = []
    for games in stages:
        ts = [t.timestamp() for t in (when(g) for g in games) if t]
        meds.append(statistics.median(ts) if ts else None)
    if n and all(m is not None for m in meds):
        cols = sorted(range(n), key=lambda i: (-meds[i], i))
    else:
        cols = list(range(n)) if orientation(stages) >= 0 else list(reversed(range(n)))
    ranks = [label_rank(nm) for nm in names] if names else [None] * n
    named = [k for k, i in enumerate(cols) if ranks[i] is not None]
    for k, i in zip(named, sorted((cols[k] for k in named), key=lambda i: (ranks[i], cols.index(i)))):
        cols[k] = i
    return {i: k for k, i in enumerate(cols)}


def find_ultirzr_id(ev):
    if ev['usau_event_id']:
        return ev['usau_event_id']
    # ultirzr's search misses on a query that carries the year.
    query = re.sub(r'\s+', ' ', re.sub(r'\b(19|20)\d\d\b', ' ', ev['name'])).strip()[:60]
    # Hits come newest-first, 20 a page, padded with loose matches, so an
    # event weeks before the season's last one sits pages deep.
    for page in range(1, 9):
        q = urllib.parse.urlencode({'year': ev['season'], 'query': query, 'page': page})
        hits = (get(f'/events/search?{q}') or {}).get('hits') or []
        exact = [h for h in hits if norm(h.get('EventName')) == norm(ev['name'])]
        if not exact:
            exact = [h for h in hits if strip_year(h.get('EventName')) == strip_year(ev['name'])
                     and (h.get('StartDate') or '')[:10] == str(ev['start_date'])]
        if len(exact) == 1:
            return exact[0]['EventId']
        if len(hits) < 20 or (hits[-1].get('StartDate') or '9')[:10] < str(ev['start_date']):
            return None
        time.sleep(0.3)
    return None


def plan_event(cur, ev):
    uid = find_ultirzr_id(ev)
    if not uid:
        return {'status': 'no_ultirzr_id'}
    full = get(f'/events/{uid}') or {}
    e = full.get('event')
    if not e:
        return {'status': 'no_payload', 'ultirzr_id': uid}

    ugames = []  # (gm, stage_name, stage_index)
    flips = 0
    for grp in e.get('EventGroups') or []:
        for rnd in grp.get('EventRounds') or []:
            for br in rnd.get('Brackets') or []:
                stages = br.get('Stage') or []
                idxs = stage_indexes([st.get('Games') or [] for st in stages],
                                     [st.get('StageName') for st in stages])
                if any(idxs[i] != i for i in idxs):
                    flips += 1
                for i, st in enumerate(stages):
                    idx = idxs[i]
                    for gm in st.get('Games') or []:
                        if gm.get('EventGameId'):
                            ugames.append((gm, st.get('StageName'), idx))
    if not ugames:
        return {'status': 'no_bracket_games', 'ultirzr_id': uid}

    cur.execute(
        """select g.id, g.usau_event_game_id, to_char(g.scheduled_at, 'MM/DD/YYYY'), g.team_a_id, g.team_b_id,
                  ta.name, tb.name, ta.usau_team_id, tb.usau_team_id, g.bracket_name
           from usau_games g
           left join usau_teams ta on ta.id = g.team_a_id
           left join usau_teams tb on tb.id = g.team_b_id
           where g.event_id = %s and g.round <> 'pool' and g.bracket_name !~* %s
             and """ + ("""g.id in (select id from usau_games_structure_backfill_20261019)"""
                       if RECOMPUTE else "g.bracket_stage_index is null"),
        (ev['id'], POOL_RE),
    )
    rows = cur.fetchall()
    by_egid = {str(gm['EventGameId']): (gm, sn, si) for gm, sn, si in ugames}
    updates, unmatched, unmatched_brackets = [], 0, {}
    for gid, egid, sched, ta, tb, na, nb, uta, utb, bname in rows:
        hit = by_egid.get(egid or '')
        if not hit and ta and tb:
            pair = {team_norm(na), team_norm(nb)}
            ids = {uta, utb}
            cands = [
                u for u in ugames
                if {team_norm(u[0].get('HomeTeamName')), team_norm(u[0].get('AwayTeamName'))} == pair
                or {str(u[0].get('HomeTeamId')), str(u[0].get('AwayTeamId'))} == ids
            ]
            if len(cands) > 1 and sched:
                # Same pair met twice in brackets: keep the one on the same day.
                same_day = [u for u in cands if u[0].get('StartDate') == sched]
                cands = same_day if len(same_day) == 1 else cands
            if len(cands) == 1:
                hit = cands[0]
        if hit:
            gm, sn, si = hit
            updates.append((str(gid), sn, si, slot_of(gm.get('GameName'))))
        else:
            unmatched += 1
            unmatched_brackets[bname] = unmatched_brackets.get(bname, 0) + 1
    return {'status': 'ok', 'ultirzr_id': uid, 'rows': len(rows), 'updates': updates,
            'unmatched': unmatched, 'unmatched_brackets': unmatched_brackets, 'flipped_brackets': flips}


def apply_event(conn, ev, updates):
    with conn.cursor() as cur:
        cur.execute(
            """create temp table if not exists _sb(id uuid, stage text, idx smallint, slot smallint) on commit delete rows"""
        )
        cur.executemany('insert into _sb values (%s, %s, %s, %s)', updates)
        if RECOMPUTE:
            # Only rows this backfill wrote, and only where the column moved.
            cur.execute(
                """update usau_games g
                   set bracket_stage = s.stage, bracket_stage_index = s.idx, bracket_slot = s.slot
                   from _sb s
                   where g.id = s.id and g.event_id = %s
                     and g.id in (select id from usau_games_structure_backfill_20261019)
                     and (g.bracket_stage_index, g.bracket_slot, g.bracket_stage)
                         is distinct from (s.idx, s.slot, s.stage)""",
                (ev['id'],),
            )
            n = cur.rowcount
            conn.commit()
            return n
        cur.execute(
            """with u as (
                 update usau_games g
                 set bracket_stage = s.stage, bracket_stage_index = s.idx, bracket_slot = s.slot
                 from _sb s
                 where g.id = s.id and g.event_id = %s and g.bracket_stage_index is null
                 returning g.id, g.event_id)
               insert into usau_games_structure_backfill_20261019 (id, event_id) select id, event_id from u""",
            (ev['id'],),
        )
        n = cur.rowcount
    conn.commit()
    return n


def main():
    conn = connect()
    with conn.cursor() as cur:
        flighted = "(e.flight_rank < 9)"
        where = {'flighted': flighted, 'rest': f'not {flighted}', 'all': 'true'}[SCOPE]
        cur.execute(
            f"""select e.id, e.season, e.name, e.usau_slug, e.usau_event_id, e.start_date
                from usau_events e
                where {where}
                  and e.end_date < current_date - 1
                  and exists (select 1 from usau_games g where g.event_id = e.id
                              and g.round <> 'pool' and g.bracket_name !~* %s
                              and """ + ("""g.id in (select id from usau_games_structure_backfill_20261019))"""
                                         if RECOMPUTE else "g.bracket_stage_index is null)") + """
                order by e.season desc, e.start_date desc, e.id""", (POOL_RE,))
        events = [dict(zip(['id', 'season', 'name', 'slug', 'usau_event_id', 'start_date'], r)) for r in cur.fetchall()]
    conn.commit()
    if SLUGS:
        events = [e for e in events if e['slug'] in SLUGS]
    if LIMIT:
        events = events[:LIMIT]
    print(f'{len(events)} events, scope={SCOPE}, apply={APPLY}', flush=True)
    tot = {'events': 0, 'rows': 0, 'matched': 0, 'written': 0, 'unmatched': 0, 'flipped': 0, 'skipped': 0}
    for i, ev in enumerate(events, 1):
        try:
            with conn.cursor() as cur:
                p = plan_event(cur, ev)
            conn.commit()
        except Exception as ex:
            conn.rollback()
            p = {'status': f'error: {ex}'}
        rec = {'event': ev['slug'], 'season': ev['season'], **{k: v for k, v in p.items() if k != 'updates'}}
        if p['status'] == 'ok':
            rec['matched'] = len(p['updates'])
            tot['rows'] += p['rows']; tot['matched'] += len(p['updates'])
            tot['unmatched'] += p['unmatched']; tot['flipped'] += p['flipped_brackets']
            if APPLY and p['updates']:
                rec['written'] = apply_event(conn, ev, p['updates'])
                tot['written'] += rec['written']
        else:
            tot['skipped'] += 1
        tot['events'] += 1
        LOG.write(json.dumps(rec, default=str) + '\n'); LOG.flush()
        print(f"[{i}/{len(events)}] {ev['season']} {ev['slug']}: {p['status']} "
              f"rows={p.get('rows')} matched={rec.get('matched')} written={rec.get('written')} "
              f"unmatched={p.get('unmatched')} flipped={p.get('flipped_brackets')}", flush=True)
        time.sleep(GAP)
    print('TOTAL', json.dumps(tot), flush=True)


main()
