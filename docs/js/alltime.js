// All-time lists: the best single seasons and the best careers, 1975 on, in the chosen measure.

import { METRIC, fmtv, getJSON, headshot, teamNames, num } from './data.js';

const LIMIT = 25;

export class AllTime {
  constructor(el, { onPick }) {
    this.el = el;
    this.onPick = onPick;
    this.expanded = false;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-more]')) {
        this.expanded = !this.expanded;
        if (this.last) this.render(this.last);
        return;
      }
      const tr = e.target.closest('tr[data-id]');
      if (tr) this.onPick(tr.dataset.id, +tr.dataset.year);
    });
  }

  async render(opts) {
    this.last = opts;
    const { index, view, metric, selected } = opts;
    const data = await getJSON('data/alltime.json');
    if (this.last !== opts) return;
    const isSeasons = view === 'seasons';
    const fields = isSeasons ? data.season_fields : data.career_fields;
    const list = (isSeasons ? data.seasons : data.careers)[metric] || [];
    const rows = list.map((x) => Object.fromEntries(fields.map((f, i) => [f, x[i]])));
    const shown = this.expanded ? rows : rows.slice(0, LIMIT);
    const M = METRIC[metric];
    const first = index.seasons[0].year;
    const last = index.seasons[index.seasons.length - 1].year;

    const note = isSeasons
      ? `Best single seasons in ${M.label.toLowerCase()}, ${first}–${last}, qualified hitters. Click one to jump to that season.`
      : `Best careers in ${M.label.toLowerCase()}, ${num(data.career_min_pa)}+ plate appearances. Only seasons from ${first} on count, so careers that started earlier are partial. Click one to jump to his best season.`;

    const body = shown.map((r, i) => {
      const year = isSeasons ? r.year : r.best_year;
      const when = isSeasons ? r.year : `${r.first}–${r.last}`;
      return `<tr data-id="${r.id}" data-year="${year}" class="${r.id === selected ? 'selected' : ''}">
        <td class="rank">${i + 1}</td>
        <td><span class="who"><img class="thumb" src="${headshot(r.mlbam, 64)}" alt="" loading="lazy">
          <span class="player-cell"><button class="player-btn" type="button">${esc(r.name)}</button>
          <span class="player-team">${esc(teamNames(index, r.teams, isSeasons ? r.year : r.last))}</span></span></span></td>
        <td>${when}</td>
        <td class="sorted">${fmtv(metric, r.value)}</td>
        <td>${num(r.pa)}</td>
      </tr>`;
    }).join('');

    this.el.innerHTML = `<p class="alltime-note">${note}</p>
      <div class="table-wrap"><table class="table">
        <thead><tr><th scope="col"><span class="visually-hidden">Rank</span>#</th><th scope="col">Player</th>
          <th scope="col">${isSeasons ? 'Season' : 'Years'}</th><th scope="col" aria-sort="descending"><span class="th-btn">${M.short}</span></th>
          <th scope="col">PA</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      ${rows.length > LIMIT ? `<button class="btn more" type="button" data-more>${this.expanded ? 'Show top 25' : `Show all ${rows.length}`}</button>` : ''}`;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
