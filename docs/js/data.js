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
    key: 'per',
    label: 'Per plate appearance',
    short: 'Per PA',
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
    label: 'Runners moved',
    short: 'Runners',
    help: 'Just the runners: of the bases they had left to reach home, how many they took on his plate appearances.',
  },
];
export const METRIC = Object.fromEntries(METRICS.map((m) => [m.key, m]));

export function measures(r) {
  return {
    cap: r.poss ? r.cap / r.poss : 0,
    per: r.pa ? r.ratio_sum / r.pa : 0,
    own: r.pa ? r.bat_cap / (4 * r.pa) : 0,
    run: r.run_poss ? r.run_cap / r.run_poss : 0,
  };
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

export function teamName(index, code) {
  const t = index.teams[code];
  return t ? t[1] : code;
}

export function teamNames(index, codes) {
  return codes.split('/').map((c) => teamName(index, c)).join(' / ');
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
    r.faintOk = r.pa >= index.faint_min_pa;
    r.team = teamNames(index, r.teams);
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
