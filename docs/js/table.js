// The leaderboard under the chart. Rows are kept by player id and slide to their new
// place (FLIP) when the season, measure or sort changes.

import { CHART_METRICS as METRICS, COMPARE_BY, val, fmtv } from './data.js';

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

    this.head(null);
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

  head(compare) {
    this.compare = compare;
    const cols = compare ? [...COLS, { key: compare, label: COMPARE_BY[compare].short || COMPARE_BY[compare].label, sortable: true }] : COLS;
    this.thead.innerHTML = cols.map((c) => c.sortable
      ? `<th scope="col" data-key="${c.key}"><button class="th-btn" type="button">${c.label}</button></th>`
      : `<th scope="col">${c.label === '#' ? '<span class="visually-hidden">Rank</span>#' : c.label}</th>`).join('');
  }

  render(opts) {
    this.last = opts;
    const { rows, ranks, sortKey, selected, faint, compare = null } = opts;
    if (compare !== this.compare) this.head(compare);
    const shown = rows.filter((r) => r.qualified || (faint && r.faintOk));
    shown.sort((a, b) => val(b, sortKey) - val(a, sortKey) || b.pa - a.pa);

    // rank among qualified hitters (ties shared at the shown 3 decimals); part-timers get none
    for (const r of shown) r._rank = ranks.get(r.id) ?? '–';

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
        METRICS.map((m) => `<td class="${m.key === sortKey ? 'sorted' : ''}">${fmtv(m.key, r.m[m.key])}</td>`).join('') +
        `<td class="${sortKey === 'pa' ? 'sorted' : ''}">${r.pa}</td>` +
        (compare ? `<td class="${sortKey === compare ? 'sorted' : ''}">${fmtv(compare, val(r, compare))}</td>` : '');
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
