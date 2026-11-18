// Loading and shaping the season and career files built by pipeline/build.py.

const cache = new Map();

export function getJSON(url) {
  if (!cache.has(url)) {
    const p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r.json();
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}

export const METRICS = [
  {
    key: 'cap',
    label: 'Bases captured',
    short: 'Captured',
    help: 'All the bases he and the runners took, divided by all the bases there were to take, over the whole season.',
  },
  {
    key: 'plus',
    label: 'Captured+',
    short: 'Captured+',
    help: 'Bases captured compared with an average hitter in the same spots that season: same runners on, same number of outs. 100 is average; 120 means 20% more. Evens out lineup spot and era.',
  },
  {
    key: 'per',
    label: 'Per plate appearance',
    short: 'Per PA',
    chart: false, // nearly the same ranking as Bases captured (r ≈ .97), so it lives only in the player panel
    help: 'The average of each plate appearance’s own ratio. Every trip to the plate counts the same, bases loaded or empty.',
  },
  {
    key: 'own',
    label: 'His own bases',
    short: 'Own',
    help: 'Just the batter’s trip: of the four bases from home back to home, how many he took. Runners left out.',
  },
  {
    key: 'run',
    label: 'Runners’ bases',
    short: 'Runners',
    help: 'Just the runners: of the bases they had left to reach home, how many they took on his plate appearances. It leans heavily on who was on base and how fast they were, so it swings a lot from year to year.',
  },
];
export const METRIC = Object.fromEntries(METRICS.map((m) => [m.key, m]));
export const CHART_METRICS = METRICS.filter((m) => m.chart !== false);

// Familiar stats to compare against, all worked out from the same Retrosheet plays.
export const COMPARE = [
  { key: 'ops', label: 'OPS', help: 'On-base plus slugging.' },
  { key: 'opsplus', label: 'OPS+', help: 'OPS against the league that season; 100 is average. No park adjustment, so it won’t match published OPS+ exactly.' },
  { key: 'avg', label: 'Batting average', short: 'AVG', help: 'Hits per at-bat.' },
  { key: 'hr', label: 'Home runs', short: 'HR', help: 'Home runs.' },
  { key: 'rbi', label: 'RBI', help: 'Runs batted in.' },
  { key: 're24', label: 'RE24', help: 'Runs he added compared with what the base-out situations he came up in would normally produce. Also accounts for who was on and how many were out.' },
];
export const COMPARE_BY = Object.fromEntries(COMPARE.map((c) => [c.key, c]));
const INT_KEYS = new Set(['plus', 'opsplus', 'hr', 'rbi']);

export function traditional(r, lg) {
  const obpDen = r.ab + r.bb + r.hbp + r.sf;
  const obp = obpDen ? (r.h + r.bb + r.hbp) / obpDen : 0;
  const slg = r.ab ? r.tb / r.ab : 0;
  return {
    avg: r.ab ? r.h / r.ab : 0,
    obp,
    slg,
    ops: obp + slg,
    opsplus: lg && lg.obp ? 100 * (obp / lg.obp + slg / lg.slg - 1) : 0,
    hr: r.hr,
    rbi: r.rbi,
    re24: r.re24,
  };
}

// a measure or comparison stat for a row
export function val(r, key) {
  if (key === 'pa') return r.pa;
  return key in r.m ? r.m[key] : r.t?.[key];
}

export function measures(r) {
  return {
    cap: r.poss ? r.cap / r.poss : 0,
    per: r.pa ? r.ratio_sum / r.pa : 0,
    own: r.pa ? r.bat_cap / (4 * r.pa) : 0,
    run: r.run_poss ? r.run_cap / r.run_poss : 0,
    plus: r.exp ? (100 * r.cap) / r.exp : 0,
  };
}

// Rank qualified hitters by a measure (or 'pa'); ties share a rank at the 3 decimals shown.
export function rankMap(rows, key) {
  const rounded = (r) => {
    const v = val(r, key);
    return key === 'pa' || INT_KEYS.has(key) ? Math.round(v) : key === 're24' ? Math.round(v * 10) : Math.round(v * 1000);
  };
  const vals = rows.filter((r) => r.qualified).map((r) => [r.id, rounded(r)]);
  const order = vals.map(([, v]) => v).sort((a, b) => b - a);
  const first = new Map();
  order.forEach((v, i) => { if (!first.has(v)) first.set(v, i + 1); });
  return new Map(vals.map(([id, v]) => [id, first.get(v)]));
}

export function seasonRanks(season, key) {
  season.ranks ??= {};
  season.ranks[key] ??= rankMap(season.rows, key);
  return season.ranks[key];
}

// format a measure's value: Captured+ is a whole number around 100, the rest are .000 rates
export function fmtv(key, v) {
  if (v == null || Number.isNaN(v)) return '—';
  if (INT_KEYS.has(key)) return String(Math.round(v));
  if (key === 're24') return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
  return fmt(v);
}

export function fmt(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const s = v.toFixed(3);
  return s.startsWith('0') ? s.slice(1) : s;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function num(n) {
  return n.toLocaleString('en-US');
}

const SILHOUETTE = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#b6bfc1"/>' +
  '<circle cx="24" cy="18" r="9" fill="#6d7e77"/><path d="M6 48c2-11 9-17 18-17s16 6 18 17Z" fill="#6d7e77"/></svg>');

export function headshot(mlbam, width = 96) {
  if (!mlbam) return SILHOUETTE;
  return `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_${width},q_auto:best/v1/people/${mlbam}/headshot/67/current`;
}
export { SILHOUETTE };

// Retrosheet keeps one code through some renames; name those by season
const RENAMED = {
  CLE: (y) => (y < 2022 ? 'Indians' : 'Guardians'),
  TBA: (y) => (y < 2008 ? 'Devil Rays' : 'Rays'),
};

export function teamName(index, code, year) {
  if (RENAMED[code] && year) return RENAMED[code](year);
  const t = index.teams[code];
  return t ? t[1] : code;
}

export function teamNames(index, codes, year) {
  return codes.split('/').map((c) => teamName(index, c, year)).join(' / ');
}

export async function loadIndex() {
  return getJSON('data/index.json');
}

export async function loadSeason(index, year) {
  const d = await getJSON(`data/batting/${year}.json`);
  const meta = index.seasons.find((s) => s.year === year) || d.meta;
  const qualPa = index.qual_pa_per_game * meta.team_games; // same 3.1-per-game line as the pipeline
  const rows = d.rows.map((x) => {
    const r = Object.fromEntries(d.fields.map((f, i) => [f, x[i]]));
    r.m = measures(r);
    r.qualified = r.pa >= qualPa;
    r.faintOk = r.pa >= index.faint_min_pa && !r.pitcher; // pitchers batting stay off the chart
    r.team = teamNames(index, r.teams, year);
    r.t = traditional(r, meta.league);
    return r;
  });
  return { year, meta, rows, qualPa, league: meta.league };
}

export async function loadCareer(index, id) {
  const shard = await getJSON(`data/careers/${id[0]}.json`);
  const p = shard[id];
  if (!p) return null;
  const f = index.career_fields;
  const seasons = p.s.map((x) => {
    const r = Object.fromEntries(f.map((k, i) => [k, x[i]]));
    r.m = measures(r);
    return r;
  });
  return { id, name: p.n, mlbam: p.m, seasons };
}
