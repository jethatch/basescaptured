#!/usr/bin/env python3
"""Build Bases Captured season files from Retrosheet parsed play-by-play.

Usage:
    python3 -I pipeline/build.py --start 1975 --end 2025

For each season this:
  1. downloads https://www.retrosheet.org/downloads/plays/{year}plays.zip into data/raw/ (cached)
  2. computes one row per plate appearance -> data/interim/{year}.csv.gz (kept for pitcher/team versions)
  3. aggregates regular-season batting  -> docs/data/batting/{year}.json
and finally rewrites, from every season file present:
  docs/data/index.json        seasons, league totals, fixed chart domains per measure, team names
  docs/data/careers/{x}.json  every player's season-by-season line, sharded by the first letter of his id
Use --index-only to redo just that last step.

Run from the project root. Only the standard library is used.
"""
import argparse
import collections
import csv
import gzip
import io
import json
import math
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path.cwd()
RAW = ROOT / 'data' / 'raw'
INTERIM = ROOT / 'data' / 'interim'
OUT = ROOT / 'docs' / 'data'
PLAYS_URL = 'https://www.retrosheet.org/downloads/plays/{year}plays.zip'
BIO_URL = 'https://www.retrosheet.org/downloads/biodata.zip'
REGISTER_URL = 'https://raw.githubusercontent.com/chadwickbureau/register/master/data/people-{h}.csv'
BASE = {'B': 0, '1': 1, '2': 2, '3': 3, 'H': 4}
ADV_RE = re.compile(r'([B123])([-X])([123H])(.*)')

BATTING_FIELDS = [
    'id', 'name', 'teams', 'pa',
    'cap', 'poss',            # combined: bases captured / possible (totals ratio = cap / poss)
    'ratio_sum',              # sum of per-PA ratios (per-PA average = ratio_sum / pa)
    'bat_cap',                # batter's own bases (own ratio = bat_cap / (4 * pa))
    'run_cap', 'run_poss',    # runners' bases advanced / possible
    'err', 'odd', 'iw',       # flags: error-gained bases, dropped-3rd-strike/interference PAs, intentional walks
    'xtra',                   # runner bases from a steal/WP/PB on the final pitch (excluded from cap, tracked)
    'mlbam',                  # MLB Advanced Media id (for headshots), from the Chadwick register; '' if unknown
    'pitcher',                # 1 if most of his plate appearances came while playing pitcher (kept off the chart)
    'exp',                    # bases an average hitter would have captured in his base-out situations (Captured+)
    'lost',                   # bases lost: for runners put out on his plays, the base each had reached (not in the stat)
    'gdp',                    # grounded into double plays
    # traditional stats for comparison (all from the same Retrosheet plays)
    'ab', 'h', 'tb', 'bb', 'hbp', 'sf', 'hr', 'rbi',
    're24',                   # runs added vs. the expected runs of each base-out state (RE24)
]
PA_FIELDS = ['gid', 'date', 'gametype', 'inning', 'top_bot', 'batter', 'pitcher', 'batteam', 'pitteam',
             'outs_pre', 'b1', 'b2', 'b3', 'event', 'possible', 'captured', 'bat_cap', 'run_cap',
             'run_poss', 'err_bases', 'extra_bases', 'odd', 'iw', 'runner_outs', 'bat_f', 'lost', 'gdp',
             'ab', 'h', 'tb', 'bb', 'hbp', 'sf', 'hr', 'rbi', 're24']


# ---------------------------------------------------------------- download

def fetch(url, dest):
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f'  downloading {url}', flush=True)
    req = urllib.request.Request(url, headers={'User-Agent': 'basescaptured-build/1.0'})
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = resp.read()
    tmp = dest.with_suffix('.part')
    tmp.write_bytes(data)
    tmp.rename(dest)
    return dest


def read_zip_csv(path, name_hint):
    with zipfile.ZipFile(path) as z:
        name = next(n for n in z.namelist() if n.lower().endswith('.csv') and name_hint in n.lower())
        with z.open(name) as f:
            yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8', errors='replace'))


# ---------------------------------------------------------------- per-PA logic (see SPEC.md)

def parse_advances(event):
    """{origin: (base, is_out, has_error)} from the text after the first '.' in the event."""
    out = {}
    if '.' not in event:
        return out
    for part in event.split('.', 1)[1].split(';'):
        m = ADV_RE.match(part)
        if not m:
            continue
        origin, sep, dest, rest = m.groups()
        fielding = [p for p in re.findall(r'\(([^)]*)\)', rest) if re.match(r'\d|E\d', p)]
        err = any('E' in p for p in fielding)
        # an error negates the out unless a clean putout is also recorded:
        # '1X2(4E6)' is safe; '2XH(E5)(12)' and 'BX3(365)(E7/TH)' are still out
        is_out = sep == 'X' and (not fielding or any('E' not in p for p in fielding))
        out[origin] = (BASE[dest], is_out, err, sep == 'X')
    return out


def hit_value(r):
    for col, v in (('single', 1), ('double', 2), ('triple', 3), ('hr', 4)):
        if r[col] == '1':
            return v
    return 0


def implied_batter_base(r):
    """Where the batter ends up when the event has no explicit B advance."""
    hv = hit_value(r)
    if hv:
        return hv
    if any(r[c] == '1' for c in ('walk', 'iw', 'hbp', 'xi', 'roe', 'fc', 'k_safe')):
        return 1
    if re.match(r'(FC|E\d|\d+E\d)', r['event']):  # 'FC/SH', '5E4/SH': sacrifice with FC or error
        return 1
    main = r['event'].split('.', 1)[0].split('/', 1)[0]
    if re.search(r'\d\([123]\)$', main):  # force out on a runner, batter safe: '64(1)' (vs '64(1)3' DP)
        return 1
    return 0


def forced_outs(event):
    """Runners put out in the main play, e.g. '64(1)3' -> {'1'}; '8(B)84(2)/LDP' -> {'B', '2'}."""
    main = event.split('.', 1)[0].split('/', 1)[0]
    outs = set(re.findall(r'\d\(([B123])\)', main))
    # caught stealing / pickoff on the final pitch, e.g. 'K+CS2(26)' (no E in the fielding = out)
    for kind, base, fld in re.findall(r'(CS|POCS|PO)([123H])\(([^)]*)\)', main):
        if 'E' not in fld:
            outs.add({'CS': str(BASE[base] - 1), 'POCS': str(BASE[base] - 1), 'PO': base}[kind])
    return outs


def end_from_event(code, start, r, adv):
    """Destination using only the event text. Returns (end_base, is_out)."""
    a = adv.get(code)
    if a:
        base, is_out = a[0], a[1]
        return (max(start, base - 1), True) if is_out else (base, False)
    if code in forced_outs(r['event']):
        return (start, True)
    if code == 'B':
        b = implied_batter_base(r)
        return (b, b == 0)
    return (start, False)


def pa_record(r, stats, game_over=False):
    r = dict(r, event=re.sub(r'[!?#]', '', r['event']))  # drop 'exceptional/uncertain play' marks: '64!(1)3'
    pre ={1: r['br1_pre'], 2: r['br2_pre'], 3: r['br3_pre']}
    post = {r['br1_post']: 1, r['br2_post']: 2, r['br3_post']: 3}
    post.pop('', None)
    scored = {r['run_b'], r['run1'], r['run2'], r['run3']} - {''}
    # post-play base state is blank when the inning or game (walk-off) ends; use the event text then
    inning_over = r['outs_post'] == '3' or game_over
    adv = parse_advances(r['event'])
    people = [('B', 0, r['batter'])] + [(str(b), b, pre[b]) for b in (1, 2, 3) if pre[b]]

    # e.g. 'K+SB2', 'W+WP': a second, non-batter event on the final pitch
    plus_event = '+' in r['event'].split('.', 1)[0].split('/', 1)[0]
    batter_reached = implied_batter_base(r) > 0 or adv.get('B', (0, True))[1] is False
    forced = {1: int(batter_reached),
              2: int(batter_reached and bool(pre[1])),
              3: int(batter_reached and bool(pre[1]) and bool(pre[2]))}

    rec = dict(possible=0, captured=0, bat_cap=0, run_cap=0, run_poss=0, err_bases=0, extra_bases=0,
               runner_outs=[])
    for code, start, pid in people:
        ev_end, ev_out = end_from_event(code, start, r, adv)
        if pid in scored:
            end, out = 4, False
        elif inning_over:
            # post-play state is blank when the inning ends; use the event text
            end, out = ev_end, ev_out
        elif pid in post:
            end, out = post[pid], False
        else:
            # put out on the play: keep bases safely reached before the out (rule 1e)
            a = adv.get(code)
            # (Retrosheet's base state is the authority that he was out, even when the text has an error)
            end, out = (max(start, a[0] - 1) if (a and a[3]) else start), True
        if not inning_over and not plus_event:  # the event parser doesn't model '+' advances
            stats['checked'] += 1
            if (ev_end, ev_out) != (end, out):
                stats['mismatch'] += 1
                if len(stats['examples']) < 5:
                    stats['examples'].append((r['gid'], r['event'], code, (ev_end, ev_out), (end, out)))

        gain = max(0, end - start)
        if code != 'B' and plus_event:
            # steal / WP / PB etc. on the final pitch: only the forced advance counts; the rest is tracked
            capped = min(gain, forced[start])
            rec['extra_bases'] += gain - capped
            gain = capped
        rec['possible'] += 4 - start
        rec['captured'] += gain
        if code == 'B':
            rec['bat_cap'] = gain
        else:
            rec['run_cap'] += gain
            rec['run_poss'] += 4 - start
            if out:
                rec['runner_outs'].append(f'{start}>{end}')  # kept for the deferred "bases lost" work
        a = adv.get(code)
        if a and a[2]:
            rec['err_bases'] += max(0, gain - hit_value(r)) if code == 'B' else gain
    if r['roe'] == '1':
        rec['err_bases'] += rec['bat_cap']
    rec['odd'] = int(r['k_safe'] == '1' or r['xi'] == '1')
    rec['iw'] = int(r['iw'] == '1')
    # bases lost (kept apart from the stat): each erased runner loses the base he had reached
    rec['lost'] = sum(int(x.split('>')[1]) for x in rec['runner_outs'])
    rec['gdp'] = int(r['gdp'] == '1')
    rec['runner_outs'] = ' '.join(rec['runner_outs'])
    for k in ('gid', 'date', 'gametype', 'inning', 'top_bot', 'batter', 'pitcher', 'batteam', 'pitteam',
              'outs_pre', 'event', 'bat_f'):
        rec[k] = r[k]
    rec['b1'], rec['b2'], rec['b3'] = (int(bool(pre[b])) for b in (1, 2, 3))
    return rec


# ---------------------------------------------------------------- season build

def build_season(year, names, mlbam, include_deduced):
    zpath = fetch(PLAYS_URL.format(year=year), RAW / f'{year}plays.zip')
    rows = list(read_zip_csv(zpath, 'plays'))
    deduced = {r['gid'] for r in rows if r['pbp'] != 'full'}
    games_by_type = collections.Counter()
    for gid, gt in {(r['gid'], r['gametype']) for r in rows}:
        games_by_type[gt] += 1

    last_row = {r['gid']: i for i, r in enumerate(rows)}  # final event of each game (walk-offs)
    re_table = run_expectancy(rows)
    stats = dict(checked=0, mismatch=0, examples=[])
    recs = []
    for i, r in enumerate(rows):
        if r['pa'] != '1' or (not include_deduced and r['gid'] in deduced):
            continue
        over = last_row[r['gid']] == i
        rec = pa_record(r, stats, game_over=over)
        rec.update(traditional(r))
        rec['re24'] = re24(r, re_table, over)
        recs.append(rec)

    INTERIM.mkdir(parents=True, exist_ok=True)
    with gzip.open(INTERIM / f'{year}.csv.gz', 'wt', newline='') as f:
        w = csv.DictWriter(f, fieldnames=PA_FIELDS)
        w.writeheader()
        w.writerows(recs)

    # regular-season batting aggregate, one row per player (teams joined in order first seen)
    agg = {}
    team_games = collections.defaultdict(set)
    for r in rows:
        if r['gametype'] == 'regular':
            team_games[r['batteam']].add(r['gid'])
    # Captured+: league average bases captured in each of the 24 base-out states this season
    state_cap = collections.defaultdict(lambda: [0, 0])
    for rec in recs:
        if rec['gametype'] == 'regular':
            sc = state_cap[(rec['outs_pre'], rec['b1'], rec['b2'], rec['b3'])]
            sc[0] += rec['captured']
            sc[1] += 1
    state_mean = {k: c / n for k, (c, n) in state_cap.items()}

    for rec in recs:
        if rec['gametype'] != 'regular':
            continue
        a = agg.get(rec['batter'])
        if a is None:
            a = agg[rec['batter']] = dict(teams=[], pa=0, cap=0, poss=0, ratio_sum=0.0, bat_cap=0,
                                          run_cap=0, run_poss=0, err=0, odd=0, iw=0, xtra=0, p_pa=0, exp=0.0, lost=0, gdp=0,
                                          ab=0, h=0, tb=0, bb=0, hbp=0, sf=0, hr=0, rbi=0, re24=0.0)
        if rec['batteam'] not in a['teams']:
            a['teams'].append(rec['batteam'])
        a['pa'] += 1
        a['cap'] += rec['captured']
        a['poss'] += rec['possible']
        a['ratio_sum'] += rec['captured'] / rec['possible']
        a['bat_cap'] += rec['bat_cap']
        a['run_cap'] += rec['run_cap']
        a['run_poss'] += rec['run_poss']
        a['err'] += rec['err_bases']
        a['odd'] += rec['odd']
        a['iw'] += rec['iw']
        a['xtra'] += rec['extra_bases']
        a['p_pa'] += rec['bat_f'] == '1'
        a['exp'] += state_mean[(rec['outs_pre'], rec['b1'], rec['b2'], rec['b3'])]
        a['lost'] += rec['lost']
        a['gdp'] += rec['gdp']
        for k in ('ab', 'h', 'tb', 'bb', 'hbp', 'sf', 'hr', 'rbi', 're24'):
            a[k] += rec[k]

    # centre RE24 so the league comes out at 0 (baserunning plays between pitches aren't credited to hitters)
    reg_pa = [x for x in recs if x['gametype'] == 'regular']
    re24_mean = sum(x['re24'] for x in reg_pa) / max(1, len(reg_pa))
    out_rows = []
    for pid, a in agg.items():
        a['re24'] -= re24_mean * a['pa']
        out_rows.append([pid, names.get(pid, pid), '/'.join(a['teams']), a['pa'], a['cap'], a['poss'],
                         round(a['ratio_sum'], 4), a['bat_cap'], a['run_cap'], a['run_poss'],
                         a['err'], a['odd'], a['iw'], a['xtra'], mlbam.get(pid, ''),
                         int(2 * a['p_pa'] > a['pa']), round(a['exp'], 2), a['lost'], a['gdp'],
                         a['ab'], a['h'], a['tb'], a['bb'], a['hbp'], a['sf'], a['hr'], a['rbi'], round(a['re24'], 1)])
    out_rows.sort(key=lambda x: -x[3])
    reg = [x for x in recs if x['gametype'] == 'regular']
    meta = dict(
        year=year,
        team_games=max((len(g) for g in team_games.values()), default=0),
        teams=sorted(team_games),
        regular_games=games_by_type.get('regular', 0),
        deduced_games=len(deduced),
        deduced_included=include_deduced,
        pa=len(reg),
        league_cap=sum(x['captured'] for x in reg),
        league_poss=sum(x['possible'] for x in reg),
    )
    (OUT / 'batting').mkdir(parents=True, exist_ok=True)
    with open(OUT / 'batting' / f'{year}.json', 'w') as f:
        json.dump(dict(meta=meta, fields=BATTING_FIELDS, rows=out_rows), f, separators=(',', ':'))
    return meta, stats


def bases_key(a, b, c):
    return (bool(a), bool(b), bool(c))


def run_expectancy(rows):
    """Average runs scored from each base-out state to the end of the half-inning (regular season)."""
    total, count = collections.Counter(), collections.Counter()
    acc, key = 0, None
    for r in reversed(rows):
        k = (r['gid'], r['inning'], r['top_bot'])
        if k != key:
            acc, key = 0, k
        acc += int(r['runs'] or 0)
        if r['gametype'] == 'regular':
            state = (r['outs_pre'], *bases_key(r['br1_pre'], r['br2_pre'], r['br3_pre']))
            total[state] += acc
            count[state] += 1
    return {s: total[s] / count[s] for s in count}


def re24(r, table, game_over):
    before = table.get((r['outs_pre'], *bases_key(r['br1_pre'], r['br2_pre'], r['br3_pre'])), 0.0)
    if r['outs_post'] == '3' or game_over:
        after = 0.0
    else:
        after = table.get((r['outs_post'], *bases_key(r['br1_post'], r['br2_post'], r['br3_post'])), 0.0)
    return after - before + int(r['runs'] or 0)


def traditional(r):
    hits = [r[k] == '1' for k in ('single', 'double', 'triple', 'hr')]
    return dict(ab=int(r['ab'] == '1'), h=int(any(hits)), tb=sum(i + 1 for i, x in enumerate(hits) if x),
                bb=int(r['walk'] == '1'), hbp=int(r['hbp'] == '1'), sf=int(r['sf'] == '1'),
                hr=int(r['hr'] == '1'), rbi=int(r['rbi'] or 0))


def load_bio():
    zpath = fetch(BIO_URL, RAW / 'biodata.zip')
    names = {}
    for r in read_zip_csv(zpath, 'biofile'):
        # Retrosheet keeps Jr./Sr./II in the full name only
        m = re.search(r'\b(Jr\.|Sr\.|II|III|IV)$', r['fullname'].strip())
        names[r['id']] = f"{r['usename']} {r['lastname']}{' ' + m.group(1) if m else ''}".strip()
    teams = {r['team']: [r['city'], r['nickname']] for r in read_zip_csv(zpath, 'teams')}
    return names, teams


def load_register():
    """Retrosheet id -> MLBAM id, from the Chadwick Bureau register (16 CSV shards)."""
    out = {}
    for h in '0123456789abcdef':
        path = fetch(REGISTER_URL.format(h=h), RAW / 'register' / f'people-{h}.csv')
        with open(path, newline='', encoding='utf-8') as f:
            for r in csv.DictReader(f):
                if r['key_retro'] and r['key_mlbam']:
                    out[r['key_retro']] = r['key_mlbam']
    return out


CAREER_FIELDS = ['year', 'teams', 'pa', 'cap', 'poss', 'ratio_sum', 'bat_cap', 'run_cap', 'run_poss',
                 'err', 'odd', 'iw', 'xtra', 'exp', 'lost', 'gdp', 'rank_cap', 'rank_per', 'rank_own', 'rank_run', 'rank_plus', 'of']
METRIC_KEYS = ('cap', 'per', 'own', 'run', 'plus')


def rank_map(qual, key):
    """Rank qualified rows by one measure; ties share a rank at the 3 decimals the page shows."""
    scale = 1 if key == 'plus' else 1000  # round half up, exactly as the page does (Math.round)
    vals = {r['id']: math.floor(measures(r)[key] * scale + 0.5) for r in qual}
    order = sorted(vals.values(), reverse=True)
    first = {}
    for i, v in enumerate(order):
        first.setdefault(v, i + 1)
    return {pid: first[v] for pid, v in vals.items()}
QUAL_PA_PER_GAME = 3.1
FAINT_MIN_PA = 100


def traditional_rates(r, lg_obp, lg_slg):
    """Comparison stats; OPS+ here is league-relative with no park adjustment."""
    ab, pa_obp = r.get('ab', 0), r.get('ab', 0) + r.get('bb', 0) + r.get('hbp', 0) + r.get('sf', 0)
    obp = (r.get('h', 0) + r.get('bb', 0) + r.get('hbp', 0)) / pa_obp if pa_obp else 0.0
    slg = r.get('tb', 0) / ab if ab else 0.0
    return dict(avg=r.get('h', 0) / ab if ab else 0.0, obp=obp, slg=slg, ops=obp + slg,
                opsplus=100 * (obp / lg_obp + slg / lg_slg - 1) if lg_obp and lg_slg else 0.0,
                hr=r.get('hr', 0), rbi=r.get('rbi', 0), re24=r.get('re24', 0.0))


def measures(r):
    """The four measures for a batting row (dict)."""
    return dict(cap=r['cap'] / r['poss'], per=r['ratio_sum'] / r['pa'], own=r['bat_cap'] / (4 * r['pa']),
                run=(r['run_cap'] / r['run_poss']) if r['run_poss'] else 0.0,
                plus=(100 * r['cap'] / r['exp']) if r.get('exp') else 0.0)


def write_index(teams):
    seasons, used = [], set()
    careers = collections.defaultdict(dict)
    spread = collections.defaultdict(list)
    qspread = collections.defaultdict(list)
    for p in sorted((OUT / 'batting').glob('*.json')):
        d = json.loads(p.read_text())
        meta, fields = d['meta'], d['fields']
        rows = [dict(zip(fields, x)) for x in d['rows']]
        qual_pa = QUAL_PA_PER_GAME * meta['team_games']
        qual = [r for r in rows if r['pa'] >= qual_pa]
        ranks = {k: rank_map(qual, k) for k in METRIC_KEYS}
        tot = {k: sum(r.get(k, 0) for r in rows) for k in ('pa', 'cap', 'poss', 'ratio_sum', 'bat_cap', 'run_cap',
                                                            'run_poss', 'ab', 'h', 'tb', 'bb', 'hbp', 'sf')}
        lg_obp = (tot['h'] + tot['bb'] + tot['hbp']) / max(1, tot['ab'] + tot['bb'] + tot['hbp'] + tot['sf'])
        lg_slg = tot['tb'] / max(1, tot['ab'])
        for r in rows:
            if r['pa'] >= FAINT_MIN_PA and not r.get('pitcher'):
                vals = dict(measures(r), **traditional_rates(r, lg_obp, lg_slg))
                for k, v in vals.items():
                    spread[k].append(v)
                    if r['pa'] >= qual_pa:
                        qspread[k].append(v)
            c = careers[r['id']].setdefault('s', [])
            careers[r['id']]['n'] = r['name']
            careers[r['id']]['m'] = r.get('mlbam', '')
            c.append([meta['year'], r['teams'], r['pa'], r['cap'], r['poss'], r['ratio_sum'], r['bat_cap'],
                      r['run_cap'], r['run_poss'], r['err'], r['odd'], r['iw'], r['xtra'], r.get('exp', 0), r.get('lost', 0), r.get('gdp', 0),
                      *(ranks[k].get(r['id']) for k in METRIC_KEYS), len(qual)])
        league = dict(cap=tot['cap'] / tot['poss'], per=tot['ratio_sum'] / tot['pa'],
                      own=tot['bat_cap'] / (4 * tot['pa']), run=tot['run_cap'] / tot['run_poss'], plus=100.0,
                      avg=tot['h'] / max(1, tot['ab']), obp=lg_obp, slg=lg_slg, ops=lg_obp + lg_slg, opsplus=100.0)
        meta = dict(meta, qualified=len(qual), qual_pa=round(qual_pa),
                    league={k: round(v, 5) for k, v in league.items()})
        seasons.append({k: v for k, v in meta.items() if k != 'teams'})
        used.update(d['meta']['teams'])

    # fixed chart domains per measure, so dots move meaningfully between seasons: every qualified season
    # from all years fits; part-timers outside it are pinned to the edge by the page
    domains = {}
    for k, vals in qspread.items():
        lo, hi = min(vals), max(vals)
        span = hi - lo
        nd = 0 if k in ('plus', 'opsplus', 'hr', 'rbi', 're24') else 3
        domains[k] = [round(lo - span * 0.03, nd), round(hi + span * 0.03, nd)]

    write_alltime(careers)

    index = dict(seasons=seasons, domains=domains, qual_pa_per_game=QUAL_PA_PER_GAME, faint_min_pa=FAINT_MIN_PA,
                 teams={t: teams.get(t, [t, t]) for t in sorted(used)}, career_fields=CAREER_FIELDS)
    with open(OUT / 'index.json', 'w') as f:
        json.dump(index, f, separators=(',', ':'))
    shards = collections.defaultdict(dict)
    for pid, c in careers.items():
        shards[pid[0]][pid] = c
    cdir = OUT / 'careers'
    cdir.mkdir(parents=True, exist_ok=True)
    for old in cdir.glob('*.json'):
        old.unlink()
    for key, players in shards.items():
        with open(cdir / f'{key}.json', 'w') as f:
            json.dump(players, f, separators=(',', ':'))
    for stale in ('seasons.json', 'teams.json'):
        (OUT / stale).unlink(missing_ok=True)


ALLTIME_KEYS = ('cap', 'plus', 'own', 'run')
ALLTIME_TOP = 100
CAREER_MIN_PA = 3000


def write_alltime(careers):
    """Top single seasons (qualified) and top careers (3,000+ PA) in each chart measure -> alltime.json."""
    seasons = {k: [] for k in ALLTIME_KEYS}
    car = {k: [] for k in ALLTIME_KEYS}
    for pid, c in careers.items():
        rows = [dict(zip(CAREER_FIELDS, x)) for x in c['s']]
        qual = [r for r in rows if r['rank_cap'] is not None]
        for r in qual:
            m = measures(r)
            for k in ALLTIME_KEYS:
                seasons[k].append((m[k], [pid, c['n'], c['m'], r['year'], r['teams'], r['pa'], r[f'rank_{k}']]))
        pa = sum(r['pa'] for r in rows)
        if pa < CAREER_MIN_PA:
            continue
        tot = {f: sum(r[f] for r in rows) for f in ('cap', 'poss', 'bat_cap', 'run_cap', 'run_poss', 'exp', 'pa')}
        vals = dict(cap=tot['cap'] / tot['poss'], own=tot['bat_cap'] / (4 * tot['pa']),
                    run=tot['run_cap'] / tot['run_poss'] if tot['run_poss'] else 0.0,
                    plus=100 * tot['cap'] / tot['exp'] if tot['exp'] else 0.0)
        teams = {}  # team -> last season with them, so renamed franchises get the right name
        for r in rows:
            for t in r['teams'].split('/'):
                teams[t] = r['year']
        for k in ALLTIME_KEYS:
            best = max(qual or rows, key=lambda r: measures(r)[k])
            car[k].append((vals[k], [pid, c['n'], c['m'], rows[0]['year'], rows[-1]['year'], pa, '/'.join(f'{t}@{y}' for t, y in teams.items()), best['year']]))

    def top(items, nd):
        items.sort(key=lambda x: -x[0])
        return [[round(v, nd)] + rest for v, rest in items[:ALLTIME_TOP]]

    out = dict(
        season_fields=['value', 'id', 'name', 'mlbam', 'year', 'teams', 'pa', 'rank'],
        career_fields=['value', 'id', 'name', 'mlbam', 'first', 'last', 'pa', 'teams', 'best_year'],
        career_min_pa=CAREER_MIN_PA,
        seasons={k: top(v, 1 if k == 'plus' else 4) for k, v in seasons.items()},
        careers={k: top(v, 1 if k == 'plus' else 4) for k, v in car.items()},
    )
    with open(OUT / 'alltime.json', 'w') as f:
        json.dump(out, f, separators=(',', ':'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', type=int)
    ap.add_argument('--end', type=int)
    ap.add_argument('--index-only', action='store_true', help='only rebuild index.json and careers/')
    ap.add_argument('--include-deduced', action='store_true',
                    help='include games Retrosheet reconstructed from box scores (excluded by default)')
    args = ap.parse_args()

    names, teams = load_bio()
    if not args.index_only:
        if args.start is None or args.end is None:
            ap.error('--start and --end are required unless --index-only')
        mlbam = load_register()
        total = dict(checked=0, mismatch=0)
        for year in range(args.start, args.end + 1):
            meta, stats = build_season(year, names, mlbam, args.include_deduced)
            total['checked'] += stats['checked']
            total['mismatch'] += stats['mismatch']
            rate = stats['mismatch'] / max(1, stats['checked'])
            print(f"{year}: {meta['pa']:>6} PA  league {meta['league_cap'] / meta['league_poss']:.3f}  "
                  f"team games {meta['team_games']:>3}  deduced {meta['deduced_games']:>3}  "
                  f"parser mismatch {stats['mismatch']} ({rate:.4%})", flush=True)
            for ex in stats['examples'][:2]:
                print('    e.g.', ex)
        print(f"parser cross-check: {total['mismatch']} of {total['checked']} player-moves disagree")
    write_index(teams)
    print('index and careers written')


if __name__ == '__main__':
    sys.exit(main())
