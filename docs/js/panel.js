// The player panel: this season's numbers, a season-by-season line against the league,
// the flags in plain words, and an expandable full-career view.

import { METRICS, METRIC, fmt, ordinal, num, headshot, teamName, loadCareer } from './data.js';

const SPARK_MIN_PA = 50;

export class Panel {
  constructor(el, { onClose }) {
    this.el = el;
    this.onClose = onClose;
    this.full = false;
    this.token = 0;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) this.onClose();
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

  async show({ index, id, year, metric, seasonRow, seasonRank, seasonCount }) {
    const token = ++this.token;
    const wasHidden = this.el.hidden;
    this.el.hidden = false;
    if (wasHidden || !this.last || this.last.id !== id) {
      this.el.innerHTML = `<div class="panel-label">Loading…</div>`;
    }
    const career = await loadCareer(index, id);
    if (token !== this.token) return;
    this.paint({ index, id, year, metric, seasonRow, seasonRank, seasonCount, career });
  }

  paint(ctx) {
    this.last = ctx;
    const { index, year, metric, seasonRank, seasonCount, career } = ctx;
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
          <span>${s ? `${esc(teamsText(index, s.teams))} · ${year} · ${s.pa} PA` : `Didn’t bat in ${year}`}</span></div>
        <button class="btn btn-icon" type="button" data-close aria-label="Close player panel">×</button>
      </div>`;

    let now = '';
    if (s) {
      const rankText = seasonRank ? `<strong>${ordinal(seasonRank)}</strong> of ${seasonCount} qualified` : 'not qualified';
      now = `
        <div class="panel-big"><span class="val">${fmt(s.m[metric])}</span>
          <span class="lbl">${M.label.toLowerCase()} · ${rankText}</span></div>
        <div class="tiles">
          ${METRICS.map((m) => `<div class="tile ${m.key === metric ? 'on' : ''}"><span class="k">${m.label}</span>
            <span class="v">${fmt(s.m[m.key])}${tileExtra(m.key, s)}</span></div>`).join('')}
        </div>`;
    }

    const spark = sparkline(career.seasons, leagueBy, metric, year);
    const notes = s ? flagNotes(s) : '';

    const careerHtml = this.full ? fullCareer(index, career) : '';

    this.el.innerHTML = `${head}${now}
      <div>
        <div class="panel-label">${M.short} by season · dashed line is the league</div>
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
  return '';
}

function flagNotes(s) {
  const out = [];
  if (s.err) out.push(`${s.err} of his bases came on fielding errors.`);
  if (s.iw) out.push(`${s.iw} intentional walk${s.iw === 1 ? '' : 's'}.`);
  if (s.odd) out.push(`Reached ${s.odd} time${s.odd === 1 ? '' : 's'} on a dropped third strike or catcher’s interference.`);
  if (s.xtra) out.push(`${s.xtra} runner base${s.xtra === 1 ? '' : 's'} from steals or wild pitches on the final pitch weren’t counted.`);
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
  const dots = pts.map((x) => `<circle class="s-pt ${x.rank ? '' : 'hollow'}" cx="${px(x.year).toFixed(1)}" cy="${py(x.m[metric]).toFixed(1)}" r="3"><title>${x.year}: ${fmt(x.m[metric])}</title></circle>`).join('');
  const sel = pts.find((x) => x.year === year);
  const now = sel ? `<circle class="s-now" cx="${px(year).toFixed(1)}" cy="${py(sel.m[metric]).toFixed(1)}" r="6"/>` : '';
  const best = pts.reduce((a, b) => (b.m[metric] > a.m[metric] ? b : a));
  const label = `${fmt(best.m[metric])} in ${best.year}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Season by season ${METRIC[metric].label.toLowerCase()}, ${y0} to ${y1}; best ${label}. Hollow points are seasons he didn't qualify.">
    <polyline class="s-league" points="${lgPts}"/>
    ${segs.filter((s) => s.length > 1).map((s) => `<polyline class="s-player" points="${s.join(' ')}"/>`).join('')}
    ${dots}${now}
    <text x="${L}" y="${H - 3}">${y0}</text>
    <text x="${W - R}" y="${H - 3}" text-anchor="end">${y1}</text>
  </svg>`;
}

function fullCareer(index, career) {
  const s = career.seasons;
  const tot = s.reduce((a, x) => ({ cap: a.cap + x.cap, poss: a.poss + x.poss, pa: a.pa + x.pa }), { cap: 0, poss: 0, pa: 0 });
  let pool = s.filter((x) => x.rank);
  if (pool.length < 3) pool = s.filter((x) => x.pa >= 100);
  const best = [...pool].sort((a, b) => b.m.cap - a.m.cap).slice(0, 3);
  const short = (x) => (x.of && x.rank ? ` · ${ordinal(x.rank)}` : '');
  const strikeShort = { 1981: 'strike-shortened', 1994: 'strike-shortened', 1995: 'shortened', 2020: '60-game season' };

  const ranks = s.map((x) => {
    const r = x.rank;
    const cls = r == null ? 'none' : r <= 10 ? 'top10' : r <= 30 ? 'top30' : '';
    return `<div class="${cls}" title="${x.year}: ${r ? `${ordinal(r)} of ${x.of}` : 'not qualified'}"><span>’${String(x.year).slice(2)}</span><strong>${r ?? '—'}</strong></div>`;
  }).join('');

  return `<div class="career">
    <div class="career-total"><span class="panel-label">Career</span><span class="val">${fmt(tot.cap / tot.poss)}</span>
      <span>${num(tot.cap)} of ${num(tot.poss)} bases · ${num(tot.pa)} PA</span></div>
    ${best.length ? `<div><span class="panel-label">Best seasons, bases captured</span><ol class="best">
      ${best.map((x) => `<li><span><strong>${x.year}</strong> ${esc(teamsText(index, x.teams))}${strikeShort[x.year] ? ` <small>(${strikeShort[x.year]})</small>` : ''}</span>
        <span><strong>${fmt(x.m.cap)}</strong>${short(x)}</span></li>`).join('')}</ol></div>` : ''}
    <div><span class="panel-label">Rank in bases captured, each season</span><div class="ranks">${ranks}</div></div>
    <div><span class="panel-label">Teams</span><p>${esc(teamSpans(index, s))}</p></div>
  </div>`;
}

function teamsText(index, codes) {
  return codes.split('/').map((c) => teamName(index, c)).join(' / ');
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
  return spans.map((sp) => `${teamName(index, sp.code)} ${sp.from === sp.to ? sp.from : `${sp.from}–${sp.to}`}`).join(' · ');
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
