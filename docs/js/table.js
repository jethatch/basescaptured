// The leaderboard under the chart. Rows are kept by player id and slide to their new
// place (FLIP) when the season, measure or sort changes.

import { METRICS, fmt } from './data.js';

const LIMIT = 25;
const COLS = [
  { key: 'rank', label: '#' },
  { key: 'player', label: 'Player' },
  ...METRICS.map((m) => ({ key: m.key, label: m.short, sortable: true })),
  { key: 'pa', label: 'PA', sortable: true },
];

export class Board {
  constructor(thead, tbody, moreBtn, { onSelect, onSort }) {
    this.thead = thead;
    this.tbody = tbody;
    this.moreBtn = moreBtn;
    this.onSelect = onSelect;
    this.onSort = onSort;
    this.expanded = false;
    this.rowsById = new Map();
    this.last = null;

    thead.innerHTML = COLS.map((c) => c.sortable
      ? `<th scope="col" data-key="${c.key}"><button class="th-btn" type="button">${c.label}</button></th>`
      : `<th scope="col">${c.label === '#' ? '<span class="visually-hidden">Rank</span>#' : c.label}</th>`).join('');
    thead.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-key]');
      if (th) this.onSort(th.dataset.key);
    });
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) this.onSelect(tr.dataset.id);
    });
    moreBtn.addEventListener('click', () => {
      this.expanded = !this.expanded;
      if (this.last) this.render(this.last);
    });
  }

  render(opts) {
    this.last = opts;
    const { rows, sortKey, selected, faint } = opts;
    const shown = rows.filter((r) => r.qualified || (faint && r.faintOk));
    const val = (r) => (sortKey === 'pa' ? r.pa : r.m[sortKey]);
    shown.sort((a, b) => val(b) - val(a) || b.pa - a.pa);

    // ranks share ties at the shown precision
    let prev = null;
    let prevRank = 0;
    shown.forEach((r, i) => {
      const key = sortKey === 'pa' ? r.pa : fmt(r.m[sortKey]);
      r._rank = key === prev ? prevRank : i + 1;
      prev = key;
      prevRank = r._rank;
    });

    let list = this.expanded ? shown : shown.slice(0, LIMIT);
    if (selected && !list.some((r) => r.id === selected)) {
      const s = shown.find((r) => r.id === selected);
      if (s) list = [...list, s];
    }

    for (const th of this.thead.querySelectorAll('th[data-key]')) {
      if (th.dataset.key === sortKey) th.setAttribute('aria-sort', 'descending');
      else th.removeAttribute('aria-sort');
    }

    // FLIP: first
    const before = new Map();
    for (const [id, tr] of this.rowsById) before.set(id, tr.getBoundingClientRect().top);

    const keep = new Set(list.map((r) => r.id));
    for (const [id, tr] of this.rowsById) {
      if (!keep.has(id)) {
        tr.remove();
        this.rowsById.delete(id);
      }
    }
    const frag = document.createDocumentFragment();
    for (const r of list) {
      let tr = this.rowsById.get(r.id);
      if (!tr) {
        tr = document.createElement('tr');
        tr.dataset.id = r.id;
        tr.className = 'entering-row';
        this.rowsById.set(r.id, tr);
      }
      tr.classList.toggle('selected', r.id === selected);
      tr.classList.toggle('faint-row', !r.qualified);
      tr.innerHTML =
        `<td class="rank">${r._rank}</td>` +
        `<td><span class="player-cell"><button class="player-btn" type="button">${esc(r.name)}</button>` +
        `<span class="player-team">${esc(r.team)}</span></span></td>` +
        METRICS.map((m) => `<td class="${m.key === sortKey ? 'sorted' : ''}">${fmt(r.m[m.key])}</td>`).join('') +
        `<td class="${sortKey === 'pa' ? 'sorted' : ''}">${r.pa}</td>`;
      frag.appendChild(tr);
    }
    this.tbody.appendChild(frag);

    // FLIP: last, invert, play
    for (const [id, tr] of this.rowsById) {
      const was = before.get(id);
      if (was == null) {
        tr.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
          { duration: 350, easing: 'ease-out' });
        continue;
      }
      const dy = was - tr.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) {
        tr.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
          { duration: 650, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
      }
    }

    const hidden = shown.length - LIMIT;
    this.moreBtn.hidden = hidden <= 0;
    this.moreBtn.textContent = this.expanded ? 'Show top 25' : `Show all ${shown.length}`;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
