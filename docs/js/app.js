import { METRICS, METRIC, fmt, ordinal, headshot, loadIndex, loadSeason } from './data.js';
import { Swarm } from './chart.js';
import { Board } from './table.js';
import { Panel } from './panel.js';

const $ = (id) => document.getElementById(id);
const TOP_FACES = 5;
const PLAY_MS = 1000;

const state = {
  year: null,
  metric: 'cap',
  sortKey: 'cap',
  faint: false,
  selected: null,
  kept: new Set(),
  playing: false,
};
let index;
let season;
let playTimer = null;
let renderToken = 0;

// ------------------------------------------------------------------ setup

async function init() {
  index = await loadIndex();
  const years = index.seasons.map((s) => s.year);
  const first = years[0];
  const last = years[years.length - 1];
  const slider = $('season');
  slider.min = first;
  slider.max = last;
  $('first-year').textContent = first;
  $('last-year').textContent = last;
  document.querySelector('.play-label').textContent = `Play ${first} → ${last}`;

  readUrl(first, last);
  slider.value = state.year;

  buildMetrics();
  buildHowMeasures();
  $('faint').checked = state.faint;

  swarm = new Swarm($('swarm'), $('axis'), {
    onHover: showTip,
    onLeave: hideTip,
    onPick: (id) => select(id),
  });
  board = new Board($('thead'), $('tbody'), $('more'), {
    onSelect: (id) => select(id),
    onSort: (key) => {
      if (key === 'pa') state.sortKey = 'pa';
      else setMetric(key);
      render();
    },
  });
  panel = new Panel($('panel'), { onClose: () => select(null) });

  slider.addEventListener('input', () => {
    stop();
    setYear(+slider.value);
  });
  $('play').addEventListener('click', () => (state.playing ? stop() : play()));
  $('faint').addEventListener('change', (e) => {
    state.faint = e.target.checked;
    render();
  });
  $('how-open').addEventListener('click', () => $('how').showModal());
  $('how').addEventListener('click', (e) => {
    if (e.target === $('how')) $('how').close();
  });
  $('theme').addEventListener('click', toggleTheme);
  syncThemeButton();
  setupSearch();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePop();
  });

  await render();
}

let swarm;
let board;
let panel;

function buildMetrics() {
  const box = $('metrics');
  box.innerHTML = METRICS.map((m) => `
    <span class="metric" data-key="${m.key}" data-on="${m.key === state.metric}">
      <button class="metric-btn" type="button" data-key="${m.key}" aria-pressed="${m.key === state.metric}">${m.label}</button>
      <button class="metric-q" type="button" data-help="${m.key}" aria-label="What is ${m.label}?">?</button>
    </span>`).join('');
  box.addEventListener('click', (e) => {
    const q = e.target.closest('[data-help]');
    if (q) {
      togglePop(q, METRIC[q.dataset.help].help);
      return;
    }
    const b = e.target.closest('.metric-btn');
    if (b) {
      setMetric(b.dataset.key);
      render();
    }
  });
  box.addEventListener('pointerover', (e) => {
    const q = e.target.closest('[data-help]');
    if (q && e.pointerType === 'mouse') showPop(q, METRIC[q.dataset.help].help);
  });
  box.addEventListener('pointerout', (e) => {
    if (e.target.closest('[data-help]') && e.pointerType === 'mouse' && !popPinned) hidePop();
  });
}

function buildHowMeasures() {
  $('how-measures').innerHTML = METRICS.map((m) => `<dt>${m.label}</dt><dd>${m.help}</dd>`).join('');
}

function setMetric(key) {
  state.metric = key;
  state.sortKey = key;
  for (const el of document.querySelectorAll('.metric')) {
    el.dataset.on = el.dataset.key === key;
    el.querySelector('.metric-btn').setAttribute('aria-pressed', el.dataset.key === key);
  }
}

// ------------------------------------------------------------------ render

async function render() {
  const token = ++renderToken;
  const s = await loadSeason(index, state.year);
  if (token !== renderToken) return;
  season = s;
  const { metric } = state;

  const qual = s.rows.filter((r) => r.qualified).sort((a, b) => b.m[metric] - a.m[metric]);
  const faces = new Set(qual.slice(0, TOP_FACES).map((r) => r.id));
  for (const id of state.kept) faces.add(id);

  const shownCount = s.rows.filter((r) => r.qualified || (state.faint && r.faintOk)).length;
  $('chart-count').textContent = state.faint
    ? `${qual.length} qualified hitters + ${shownCount - qual.length} part-timers`
    : `${qual.length} qualified hitters`;

  swarm.update({
    rows: s.rows,
    metric,
    domain: index.domains[metric],
    league: s.league[metric],
    faces,
    selected: state.selected,
    faint: state.faint,
  });
  board.render({ rows: s.rows, sortKey: state.sortKey, selected: state.selected, faint: state.faint });
  fillNames(s.rows);

  if (state.selected) {
    const row = s.rows.find((r) => r.id === state.selected);
    const rank = row && row.qualified ? 1 + qual.filter((r) => r.m[metric] > row.m[metric]).length : null;
    $('main').classList.add('has-panel');
    panel.show({ index, id: state.selected, year: state.year, metric, seasonRow: row, seasonRank: rank, seasonCount: qual.length });
  } else {
    $('main').classList.remove('has-panel');
    panel.hide();
  }
  writeUrl();

  // warm the next season so playback and the slider feel instant
  const next = index.seasons.find((x) => x.year === state.year + 1);
  if (next) loadSeason(index, next.year).catch(() => {});
}

function setYear(y) {
  if (y === state.year) return;
  state.year = y;
  const out = $('year');
  out.textContent = y;
  out.classList.remove('bump');
  void out.offsetWidth;
  out.classList.add('bump');
  $('season').value = y;
  render();
}

function select(id) {
  if (id && id === state.selected) {
    // clicking the selected player again lets go of them
    state.kept.delete(id);
    id = null;
  }
  if (state.selected && state.selected !== id) state.kept.delete(state.selected);
  state.selected = id;
  if (id) state.kept.add(id);
  hideTip();
  render();
}

// ------------------------------------------------------------------ playback

function play() {
  const last = index.seasons[index.seasons.length - 1].year;
  const first = index.seasons[0].year;
  if (state.year >= last) setYear(first);
  state.playing = true;
  $('play').setAttribute('aria-pressed', 'true');
  $('play').querySelector('.play-label').textContent = 'Pause';
  playTimer = setInterval(() => {
    if (state.year >= last) {
      stop();
      return;
    }
    setYear(state.year + 1);
  }, PLAY_MS);
}

function stop() {
  if (!state.playing) return;
  state.playing = false;
  clearInterval(playTimer);
  $('play').setAttribute('aria-pressed', 'false');
  const s = index.seasons;
  $('play').querySelector('.play-label').textContent = `Play ${s[0].year} → ${s[s.length - 1].year}`;
}

// ------------------------------------------------------------------ hover card

function showTip(id, node) {
  if (!season) return;
  const r = season.rows.find((x) => x.id === id);
  if (!r) return;
  const tip = $('tip');
  const qual = season.rows.filter((x) => x.qualified);
  const rank = r.qualified ? 1 + qual.filter((x) => x.m[state.metric] > r.m[state.metric]).length : null;
  tip.innerHTML = `<img src="${headshot(r.mlbam)}" alt="">
    <span><strong>${esc(r.name)}</strong>${esc(r.team)} · ${r.pa} PA<br>
    <span class="tip-val">${fmt(r.m[state.metric])}</span> ${rank ? ordinal(rank) : 'part-timer'}</span>`;
  tip.hidden = false;
  const b = node.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let x = b.left + b.width / 2 - t.width / 2;
  let y = b.top - t.height - 12;
  if (y < 8) y = b.bottom + 12;
  x = Math.max(8, Math.min(window.innerWidth - t.width - 8, x));
  tip.style.transform = `translate(${x}px, ${y}px)`;
  node.classList.add('hovered');
}

function hideTip(id) {
  $('tip').hidden = true;
  for (const n of document.querySelectorAll('.dot.hovered')) n.classList.remove('hovered');
}

// ------------------------------------------------------------------ "?" popovers

let popPinned = false;
let popFor = null;

function showPop(anchor, text) {
  const pop = $('pop');
  pop.textContent = text;
  pop.hidden = false;
  const b = anchor.getBoundingClientRect();
  const p = pop.getBoundingClientRect();
  const x = Math.max(8, Math.min(window.innerWidth - p.width - 8, b.left + b.width / 2 - p.width / 2));
  pop.style.left = `${x}px`;
  pop.style.top = `${b.bottom + 8}px`;
  popFor = anchor;
  anchor.setAttribute('aria-describedby', 'pop');
}

function hidePop() {
  $('pop').hidden = true;
  popPinned = false;
  if (popFor) popFor.removeAttribute('aria-describedby');
  popFor = null;
}

function togglePop(anchor, text) {
  if (popFor === anchor && popPinned) {
    hidePop();
    return;
  }
  showPop(anchor, text);
  popPinned = true;
}
document.addEventListener('click', (e) => {
  if (popPinned && !e.target.closest('[data-help]') && !e.target.closest('#pop')) hidePop();
});

// ------------------------------------------------------------------ search

function fillNames(rows) {
  const names = rows.filter((r) => r.qualified || (state.faint && r.faintOk)).map((r) => r.name).sort();
  const key = state.year + ':' + state.faint;
  const dl = $('names');
  if (dl.dataset.key === key) return;
  dl.dataset.key = key;
  dl.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
}

function setupSearch() {
  const input = $('search-input');
  const go = () => {
    if (!season) return;
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    const pool = season.rows.filter((r) => r.pa > 0);
    const hit = pool.find((r) => r.name.toLowerCase() === q) || pool.find((r) => r.name.toLowerCase().includes(q));
    if (!hit) {
      input.setCustomValidity(`No one by that name batted in ${state.year}`);
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    if (!hit.qualified && !(state.faint && hit.faintOk)) {
      state.faint = hit.faintOk || state.faint;
      $('faint').checked = state.faint;
    }
    if (hit.id !== state.selected) select(hit.id);
    input.value = '';
    setTimeout(() => {
      const n = swarm.nodeFor(hit.id);
      if (n) {
        n.classList.remove('found');
        void n.offsetWidth;
        n.classList.add('found');
      }
    }, 750);
  };
  $('search').addEventListener('submit', (e) => {
    e.preventDefault();
    go();
  });
  input.addEventListener('change', go);
  input.addEventListener('input', () => input.setCustomValidity(''));
}

// ------------------------------------------------------------------ theme

function effectiveDark() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function toggleTheme() {
  const next = effectiveDark() ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('bc-theme', next); } catch (e) { /* private mode */ }
  syncThemeButton();
}

function syncThemeButton() {
  $('theme').setAttribute('aria-label', effectiveDark() ? 'Switch to light theme' : 'Switch to dark theme');
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeButton);

// ------------------------------------------------------------------ links

function readUrl(first, last) {
  const p = new URLSearchParams(location.search);
  const y = parseInt(p.get('y'), 10);
  state.year = y >= first && y <= last ? y : last;
  $('year').textContent = state.year;
  const m = p.get('m');
  if (METRIC[m]) {
    state.metric = m;
    state.sortKey = m;
  }
  if (p.get('s') === 'pa') state.sortKey = 'pa';
  state.faint = p.get('f') === '1';
  const id = p.get('p');
  if (id && /^[a-z0-9-]{8}$/.test(id)) {
    state.selected = id;
    state.kept.add(id);
  }
}

function writeUrl() {
  const p = new URLSearchParams();
  p.set('y', state.year);
  if (state.metric !== 'cap') p.set('m', state.metric);
  if (state.sortKey === 'pa') p.set('s', 'pa');
  if (state.faint) p.set('f', '1');
  if (state.selected) p.set('p', state.selected);
  history.replaceState(null, '', `${location.pathname}?${p}`);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

init().catch((err) => {
  console.error(err);
  document.querySelector('.main').innerHTML = `<p>Couldn’t load the data (${esc(err.message)}).</p>`;
});
