// The player panel: this season's numbers, a season-by-season line against the league,
// the flags in plain words, and an expandable full-career view.

import { METRICS, METRIC, fmt, fmtv, ordinal, num, headshot, teamName, loadCareer } from './data.js';

const SPARK_MIN_PA = 50;

export class Panel {
  constructor(el, { onClose }) {
    this.el = el;
    this.onClose = onClose;
    this.full = false;
    this.open = false; // on phones the sheet starts small: name and headline number only
    this.token = 0;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) this.onClose();
      if (e.target.closest('[data-expand]')) {
        this.open = !this.open;
        if (this.last) this.paint(this.last);
      }
      if (e.target.closest('[data-career]')) {
        this.full = !this.full;
        if (this.last) this.paint(this.last);
      }
    });
  }

  hide() {
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.last = null;
  }

  async show({ index, id, year, metric, seasonRow, seasonRank, seasonCount, others = [] }) {
    const token = ++this.token;
    const wasHidden = this.el.hidden;
    this.el.hidden = false;
    if (wasHidden || !this.last || this.last.id !== id) {
      this.el.innerHTML = `<div class="panel-label">Loading…</div>`;
      this.open = false;
    }
    const career = await loadCareer(index, id);
    if (token !== this.token) return;
    this.paint({ index, id, year, metric, seasonRow, seasonRank, seasonCount, career, others });
  }

  paint(ctx) {
    this.last = ctx;
    const { index, year, metric, seasonRank, seasonCount, career, others } = ctx;
    if (!career) {
      this.el.innerHTML = `<button class="btn btn-icon" data-close aria-label="Close">×</button><p>No record for this player.</p>`;
      return;
    }
    const s = career.seasons.find((x) => x.year === year);
    const M = METRIC[metric];
    const leagueBy = new Map(index.seasons.map((x) => [x.year, x.league]));

    const head = `
      <div class="panel-head">
        <img src="${headshot(career.mlbam, 120)}" alt="">
        <div class="panel-name"><strong>${esc(career.name)}</strong>
          <span>${s ? `${esc(teamsText(index, s.teams, year))} · ${year} · ${s.pa} PA` : `Didn’t bat in ${year}`}</span></div>
        <button class="btn btn-icon" type="button" data-close aria-label="Close player panel">×</button>
      </div>`;

    let now = '';
    if (s) {
      const rankText = seasonRank ? `<strong>${ordinal(seasonRank)}</strong> of ${seasonCount} qualified` : 'not qualified';
      now = `
        <div class="panel-big"><span class="val">${fmtv(metric, s.m[metric])}</span>
          <span class="lbl">${M.label.toLowerCase()} · ${rankText}</span></div>
        <div class="tiles">
          ${METRICS.map((m) => `<div class="tile ${m.key === metric ? 'on' : ''}"><span class="k">${m.label}</span>
            <span class="v">${fmtv(m.key, s.m[m.key])}${tileExtra(m.key, s)}</span></div>`).join('')}
        </div>`;
    }

    const compare = others && others.length ? `
      <div><div class="panel-label">How else he ranked in ${year}</div>
        <ul class="others">${others.map((o) => `<li class="${o.ours ? 'ours' : ''}"><span class="o-k">${o.label}</span>
          <span class="o-v">${o.value}</span><span class="o-r">${o.rank ? ordinal(o.rank) : '—'}</span></li>`).join('')}</ul></div>` : '';
    const spark = sparkline(career.seasons, leagueBy, metric, year);
    const notes = s ? flagNotes(s) : '';

    const careerHtml = this.full ? fullCareer(index, career, metric, leagueBy) : '';

    this.el.classList.toggle('open', this.open);
    const expand = `<button class="btn panel-expand" type="button" data-expand aria-expanded="${this.open}">
      ${this.open ? 'Hide details ▾' : 'Show details ▴'}</button>`;
    this.el.innerHTML = `${head}${now}${expand}${compare}
      <div>
        <div class="panel-label">${M.short} by season · dashed line is the league · hollow = not qualified</div>
        ${spark}
      </div>
      ${notes ? `<div class="notes">${notes}</div>` : ''}
      ${careerHtml}
      <button class="btn panel-toggle" type="button" data-career aria-expanded="${this.full}">
        ${this.full ? 'Show less ▴' : 'See full career ▾'}</button>`;
  }
}

function tileExtra(key, s) {
  if (key === 'cap') return ` <small>${num(s.cap)} of ${num(s.poss)}</small>`;
  if (key === 'own') return ` <small>${num(s.bat_cap)} of ${num(4 * s.pa)}</small>`;
  if (key === 'run') return ` <small>${num(s.run_cap)} of ${num(s.run_poss)}</small>`;
  if (key === 'plus') return ' <small>100 = average</small>';
  return '';
}

function flagNotes(s) {
  const out = [];
  if (s.lost || s.gdp) {
    const parts = [];
    if (s.lost) parts.push(`runners put out on his plate appearances lost ${s.lost} base${s.lost === 1 ? '' : 's'} they had already reached`);
    if (s.gdp) parts.push(`he grounded into ${s.gdp} double play${s.gdp === 1 ? '' : 's'}`);
    const t = parts.join('; ');
    out.push(`<strong>Bases lost:</strong> ${t[0].toUpperCase()}${t.slice(1)}. (Not counted against the stat.)`);
  }
  if (s.err) out.push(`${s.err} of his bases came on fielding errors.`);
  if (s.iw) out.push(`${s.iw} intentional walk${s.iw === 1 ? '' : 's'}.`);
  if (s.odd) out.push(`Reached ${s.odd} time${s.odd === 1 ? '' : 's'} on a dropped third strike or catcher’s interference.`);
  return out.map((t) => `<p>${t}</p>`).join('');
}

function sparkline(seasons, leagueBy, metric, year) {
  const pts = seasons.filter((x) => x.pa >= SPARK_MIN_PA);
  if (!pts.length) return '<p class="notes">Not enough plate appearances to draw a line.</p>';
  const y0 = seasons[0].year;
  const y1 = seasons[seasons.length - 1].year;
  const years = [];
  for (let y = y0; y <= y1; y++) years.push(y);
  const lg = years.map((y) => leagueBy.get(y)?.[metric]).filter((v) => v != null);
  const vals = pts.map((x) => x.m[metric]).concat(lg);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = Math.max(0.005, (hi - lo) * 0.12);
  lo -= pad;
  hi += pad;
  const W = 320;
  const H = 120;
  const L = 6;
  const R = 6;
  const T = 8;
  const B = 18;
  const px = (y) => (y1 === y0 ? W / 2 : L + ((y - y0) / (y1 - y0)) * (W - L - R));
  const py = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  const lgPts = years.filter((y) => leagueBy.get(y)).map((y) => `${px(y).toFixed(1)},${py(leagueBy.get(y)[metric]).toFixed(1)}`).join(' ');
  // break the player's line across gaps of missing seasons
  const segs = [];
  let cur = [];
  let prevYear = null;
  for (const x of pts) {
    if (prevYear != null && x.year !== prevYear + 1) {
      segs.push(cur);
      cur = [];
    }
    cur.push(`${px(x.year).toFixed(1)},${py(x.m[metric]).toFixed(1)}`);
    prevYear = x.year;
  }
  segs.push(cur);
  const dots = pts.map((x) => `<circle class="s-pt ${x.of && x.rank_cap != null ? '' : 'hollow'}" cx="${px(x.year).toFixed(1)}" cy="${py(x.m[metric]).toFixed(1)}" r="3"><title>${x.year}: ${fmtv(metric, x.m[metric])}</title></circle>`).join('');
  const sel = pts.find((x) => x.year === year);
  const now = sel ? `<circle class="s-now" cx="${px(year).toFixed(1)}" cy="${py(sel.m[metric]).toFixed(1)}" r="6"/>` : '';
  const best = pts.reduce((a, b) => (b.m[metric] > a.m[metric] ? b : a));
  const label = `${fmtv(metric, best.m[metric])} in ${best.year}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Season by season ${METRIC[metric].label.toLowerCase()}, ${y0} to ${y1}; best ${label}. Hollow points are seasons he didn't qualify.">
    <polyline class="s-league" points="${lgPts}"/>
    ${segs.filter((s) => s.length > 1).map((s) => `<polyline class="s-player" points="${s.join(' ')}"/>`).join('')}
    ${dots}${now}
    <text x="${L}" y="${H - 3}">${y0}</text>
    <text x="${W - R}" y="${H - 3}" text-anchor="end">${y1}</text>
  </svg>`;
}

function fullCareer(index, career, metric, leagueBy) {
  const s = career.seasons;
  const tot = s.reduce((a, x) => ({ cap: a.cap + x.cap, poss: a.poss + x.poss, pa: a.pa + x.pa, exp: a.exp + (x.exp || 0), lost: a.lost + (x.lost || 0), gdp: a.gdp + (x.gdp || 0) }), { cap: 0, poss: 0, pa: 0, exp: 0, lost: 0, gdp: 0 });
  // what the league captured over the same seasons, weighted by his chances
  const lgCap = s.reduce((a, x) => a + (leagueBy.get(x.year)?.cap ?? 0) * x.poss, 0) / tot.poss;
  const rk = (x) => x[`rank_${metric}`];
  let pool = s.filter((x) => rk(x) != null);
  if (pool.length < 3) pool = s.filter((x) => x.pa >= 100);
  const best = [...pool].sort((a, b) => b.m[metric] - a.m[metric]).slice(0, 3);
  const short = (x) => (rk(x) ? ` · ${ordinal(rk(x))}` : '');
  const label = METRIC[metric].label.toLowerCase();
  const strikeShort = { 1981: 'strike-shortened', 1994: 'strike-shortened', 1995: 'shortened', 2020: '60-game season' };

  const ranks = s.map((x) => {
    const r = rk(x);
    const cls = r == null ? 'none' : r <= 10 ? 'top10' : r <= 30 ? 'top30' : '';
    return `<div class="${cls}" title="${x.year}: ${r ? `${ordinal(r)} of ${x.of}` : 'not qualified'}"><span>’${String(x.year).slice(2)}</span><strong>${r ?? '—'}</strong></div>`;
  }).join('');

  return `<div class="career">
    <div class="career-total"><span class="panel-label">Career</span><span class="val">${fmt(tot.cap / tot.poss)}</span>
      <span>${num(tot.cap)} of ${num(tot.poss)} bases · ${num(tot.pa)} PA · league ${fmt(lgCap)} in his years${tot.exp ? ` · Captured+ ${Math.round((100 * tot.cap) / tot.exp)}` : ''}</span>
      <span>Bases lost ${num(tot.lost)} · ${num(tot.gdp)} double plays</span></div>
    ${best.length ? `<div><span class="panel-label">Best seasons, ${label}</span><ol class="best">
      ${best.map((x) => `<li><span><strong>${x.year}</strong> ${esc(teamsText(index, x.teams, x.year))}${strikeShort[x.year] ? ` <small>(${strikeShort[x.year]})</small>` : ''}</span>
        <span><strong>${fmtv(metric, x.m[metric])}</strong>${short(x)}</span></li>`).join('')}</ol></div>` : ''}
    <div><span class="panel-label">Rank in ${label}, each season</span><div class="ranks">${ranks}</div></div>
    <div><span class="panel-label">Teams</span><p>${esc(teamSpans(index, s))}</p></div>
  </div>`;
}

function teamsText(index, codes, year) {
  return codes.split('/').map((c) => teamName(index, c, year)).join(' / ');
}

function teamSpans(index, seasons) {
  const spans = [];
  for (const x of seasons) {
    for (const code of x.teams.split('/')) {
      const last = spans.find((sp) => sp.code === code && sp.to >= x.year - 1);
      if (last) last.to = x.year;
      else spans.push({ code, from: x.year, to: x.year });
    }
  }
  return spans.map((sp) => `${teamName(index, sp.code, sp.to)} ${sp.from === sp.to ? sp.from : `${sp.from}–${sp.to}`}`).join(' · ');
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
