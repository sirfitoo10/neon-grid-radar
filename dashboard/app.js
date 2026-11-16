// NEON GRID dashboard: four views over the model's dataset, no framework, no network.
// data.js (written beside this page by the entry program) sets window.RADAR.

const R = window.RADAR;

const fmtUsd = (n) => {
  if (n === null || n === undefined) return '—';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n;
};
const fmtPct = (n) => (n === null || n === undefined) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
const fmtAge = (d) => d === null || d === undefined ? 'unknown' : d >= 365 ? Math.floor(d / 365) + 'y ' + (d % 365) + 'd' : d + 'd';

const state = { view: 'board', sort: 'rank', dir: 1, q: '', wlOnly: false, slug: null };

const main = document.getElementById('main');
document.getElementById('asof').textContent = 'Snapshot as of ' + R.as_of + ' · source: ' + R.source + ' · watchlist floor ' + fmtUsd(R.floor_usd);

// headline strip
document.getElementById('strip').innerHTML = `
  <div><dt>Watchlist</dt><dd>${R.watchlist_size}</dd></div>
  <div><dt>Board rows</dt><dd>${R.board_size}</dd></div>
  <div><dt>Early finds</dt><dd>${R.early_size}</dd></div>
  <div><dt>Live peers</dt><dd>${R.live_size}</dd></div>
  <div><dt>Market mcap/TVL</dt><dd>${R.calibration.market_multiple.toFixed(2)}×</dd></div>
`;

// ---------- board view ----------
function boardHtml() {
  const watch = new Set(R.rows.map((r) => r).slice(0, 0)); // placeholder, watchlist membership via radar
  const wlSlugs = new Set();
  // The model marks watchlist membership through the calibration's floor: rows above the floor band
  // are watchlist; the program passes membership in the row via the snapshot. data.js rows carry
  // early vs watchlist via the board: rebuild from rows order is not enough, so use the floor: any
  // row whose TVL is at or above the floor is a watchlist protocol (the floor is the watchlist rule).
  return `
  <div class="controls">
    <input type="search" id="q" placeholder="Search name, category, chain…" value="${state.q.replace(/"/g, '&quot;')}">
    <select id="cat"><option value="">All categories</option>${catOptions()}</select>
    <button class="pill ${state.wlOnly ? 'is-on' : ''}" id="wlOnly">★ Watchlist only</button>
    <label>min TVL <input type="number" id="minTvl" style="width:110px" placeholder="0"></label>
    <span class="foot-note" id="count"></span>
  </div>
  <div class="tbl-wrap"><table>
    <thead><tr>
      ${th('rank', '#')}${th('name', 'Protocol')}${th('category', 'Category')}${th('tvl_usd', 'TVL')}${th('change_7d', '7d')}
      ${th('implied_value_usd', 'Implied value')}${th('age_days', 'No-token age')}${th('growth_multiplier', 'g ×')}${th('maturity_multiplier', 'm ×')}${th('scarcity_multiplier', 's ×')}
    </tr></thead>
    <tbody>${rowsHtml()}</tbody>
  </table></div>
  <p class="foot-note">★ marks a watchlist protocol (TVL at or above the floor, no token, not a wrapper). Every row carries a farm plan — click it. Implied value = TVL × category base × growth × maturity × scarcity, all shown.</p>`;
}

function th(key, label) { return `<th data-k="${key}" class="${state.sort === key ? 'is-sorted' : ''}">${label}${state.sort === key ? (state.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`; }

function catOptions() {
  const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
  return cats.map((c) => `<option ${state.cat === c ? 'selected' : ''} value="${c}">${c}</option>`).join('');
}

function filteredRows() {
  const q = state.q.trim().toLowerCase();
  const minTvl = Number(state.minTvl || 0);
  let rows = R.rows.filter((r) => {
    if (state.wlOnly && r.tvl_usd < R.floor_usd) return false;
    if (state.cat && r.category !== state.cat) return false;
    if (minTvl && r.tvl_usd < minTvl) return false;
    if (q && !(r.name.toLowerCase().includes(q) || (r.category || '').toLowerCase().includes(q) || r.chains.join(' ').toLowerCase().includes(q) || r.slug.includes(q))) return false;
    return true;
  });
  const k = state.sort, d = state.dir;
  rows = [...rows].sort((a, b) => {
    const av = a[k], bv = b[k];
    if (typeof av === 'string' || typeof bv === 'string') return d * String(av ?? '').localeCompare(String(bv ?? ''));
    return d * ((av ?? 0) - (bv ?? 0));
  });
  return rows;
}

function rowsHtml() {
  const rows = filteredRows();
  const maxImp = Math.log10(Math.max(...R.rows.map((r) => r.implied_value_usd))) || 1;
  const count = document.getElementById('count');
  if (count) count.textContent = rows.length + ' of ' + R.board_size + ' rows';
  return rows.map((r) => {
    const star = r.tvl_usd >= R.floor_usd ? '<span class="wl-star" title="Watchlist protocol">★</span>' : '';
    const meter = Math.max(4, Math.round((Math.log10(r.implied_value_usd) / maxImp) * 100));
    const ch = r.change_7d;
    return `<tr data-slug="${r.slug}">
      <td class="rank-cell">#${r.rank}</td>
      <td class="name-cell">${star} ${r.name}</td>
      <td class="cat">${r.category ?? '—'}<br><span>${r.chains.slice(0, 2).map((c) => `<span class="chip">${c}</span>`).join('')}</span></td>
      <td class="num">${fmtUsd(r.tvl_usd)}</td>
      <td class="num ${ch >= 0 ? 'up' : 'down'}">${fmtPct(ch)}</td>
      <td class="num imp">${fmtUsd(r.implied_value_usd)}<span class="meter"><i style="width:${meter}%"></i></span></td>
      <td class="age-cell">${fmtAge(r.age_days)}</td>
      <td class="num">${r.growth_multiplier.toFixed(2)}×</td>
      <td class="num">${r.maturity_multiplier.toFixed(2)}×</td>
      <td class="num">${r.scarcity_multiplier.toFixed(2)}×</td>
    </tr>`;
  }).join('');
}

// ---------- detail view ----------
function detailHtml(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) return '<p class="foot-note">Row not found.</p>';
  const steps = farmStepsFor(r);
  return `
  <button class="back" data-back>← Back to the board</button>
  <div class="detail">
    <h2>#${r.rank} · ${r.name}</h2>
    <p class="sub">${r.category ?? 'Uncategorized'} · ${r.chains.join(', ')} · tracked since ${r.listed_at ?? 'an unknown date'} · ${r.tvl_usd >= R.floor_usd ? 'on the house watchlist' : 'an early find below the floor'}</p>
    <dl class="kv-grid">
      <div class="kv"><dt>TVL</dt><dd>${fmtUsd(r.tvl_usd)}</dd></div>
      <div class="kv"><dt>7d change</dt><dd class="${(r.change_7d ?? 0) >= 0 ? 'up' : 'down'}">${fmtPct(r.change_7d ?? null)}</dd></div>
      <div class="kv"><dt>No-token age</dt><dd>${fmtAge(r.age_days)}</dd></div>
      <div class="kv"><dt>Implied value</dt><dd class="imp">${fmtUsd(r.implied_value_usd)}</dd></div>
    </dl>
    <div class="mults">
      <span class="mult">base <b>${r.base_multiple.toFixed(2)}×</b></span>
      <span class="mult">growth <b>${r.growth_multiplier.toFixed(2)}×</b> (${fmtPct(r.model ? null : null)})</span>
      <span class="mult">maturity <b>${r.maturity_multiplier.toFixed(2)}×</b></span>
      <span class="mult">scarcity <b>${r.scarcity_multiplier.toFixed(2)}×</b></span>
    </div>
    <h3 style="margin:22px 0 6px">How to farm it</h3>
    <ol class="steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
  </div>`;
}

// The page rebuilds each row's plan from the same deterministic rules the program used: the category
// action, the capital band and the hold window all follow from the row's own figures.
function farmStepsFor(r) {
  const chain = r.chains[0] || 'its main chain';
  const capital = r.tvl_usd >= 5e9 ? 250 : r.tvl_usd >= 1e9 ? 150 : r.tvl_usd >= 1e8 ? 100 : 50;
  const c = (r.category || '').toLowerCase();
  const n = r.name;
  const action =
    c.includes('lend') || c.includes('cdp') || c.includes('collateral') ? `Supply $${capital} of USDC to ${n} on ${chain}, then borrow against half of it and repay the borrow once.` :
    c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') ? `Provide $${capital} of liquidity to ${n}'s largest pool on ${chain} and leave a second small swap through the same pool.` :
    c.includes('bridge') ? `Bridge $${capital} of USDC to ${chain} through ${n}, then use the bridged funds inside its app once.` :
    c.includes('staking') || c.includes('restak') ? `Stake $${capital} of the chain's staking asset through ${n} and keep the liquid receipt token.` :
    c.includes('perpetual') || c.includes('derivative') ? `Deposit $${capital} of USDC as margin on ${n}, open one small position, then close it.` :
    c.includes('curator') || c.includes('allocator') ? `Deposit $${capital} into a ${n} vault on ${chain} and hold the shares for the full window.` :
    c.includes('basis') ? `Open the basis trade ${n} automates with $${capital}: spot long, perp short, one full round trip.` :
    c.includes('rwa') ? `Mint $${capital} of the protocol's yield asset on ${chain} and hold it across a full epoch.` :
    c.includes('insurance') ? `Buy $${capital} of cover from ${n} on ${chain} and keep the policy through expiry.` :
    c.includes('stable') ? `Mint $${capital} of the stable asset through ${n} on ${chain}, redeem a third, and mint again.` :
    `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open.`;
  const hold = r.age_days === null ? 45 : r.age_days < 180 ? 60 : r.age_days < 365 ? 45 : 30;
  const old = r.age_days !== null && r.age_days > 730 ? ' — the protocol has run long without a token, so an airdrop can land any month' : '';
  return [
    `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
    action,
    `Make one qualifying action each week — a deposit, a borrow, a swap, a vote or a liquidity add — from the same wallet.`,
    `Hold the position at least ${hold} days so the wallet is counted in several weekly snapshots${old}.`,
    `Track the wallet's volume against the level other farmers report on the protocol's own points page, and top up if it sits in the bottom band.`,
    `Claim only from the protocol's own page once a token or points redemption appears; never pay a third party to claim.`,
    `Write the wallet, the dates and every transaction in a farm log so the position can be repeated or unwound without guessing.`,
  ];
}

// ---------- market view ----------
function marketHtml() {
  return `
  <div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Protocol</th><th>Category</th><th>TVL</th><th>Market cap</th><th>7d</th><th>mcap/TVL</th></tr></thead>
    <tbody>${R.live.map((p, i) => `
      <tr><td class="rank-cell">${i + 1}</td>
      <td class="name-cell">${p.name}</td>
      <td class="cat">${p.category ?? '—'}</td>
      <td class="num">${fmtUsd(p.tvl_usd)}</td>
      <td class="num">${fmtUsd(p.mcap_usd)}</td>
      <td class="num ${(p.change_7d ?? 0) >= 0 ? 'up' : 'down'}">${fmtPct(p.change_7d)}</td>
      <td class="num">${p.mcap_tvl_ratio === null ? '—' : p.mcap_tvl_ratio.toFixed(2) + '×'}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="foot-note">These are the snapshot's trading protocols: their market cap per dollar of TVL is the pricing the model calibrates every pre-token row against. ${R.calibration.live_peer_count} live peers feed the category medians.</p>`;
}

// ---------- model view ----------
function modelHtml() {
  const cal = Object.entries(R.calibration.category_multiples).sort((a, b) => b[1] - a[1]);
  return `
  <div class="model-view">
    <h2>The model, stated</h2>
    <p>NEON GRID prices a pre-token protocol at what the market already pays per dollar of TVL for
    its category's tokens, adjusted for momentum, how long it has run without issuing one, and how
    scarce its category's tokens are. Every input is the snapshot's; no name is special-cased.</p>
    <div class="formula">implied = TVL × base(category) × growth × maturity × scarcity

base(category)   = median mcap/TVL of the category's live peers ≥ $10M TVL
                   (no peers: the market-wide median ${R.calibration.market_multiple.toFixed(2)}×, clamped ${R.model.multiple_min}–${R.model.multiple_max}×)
growth           = 1 + (|7d %| − noise) × weight × sign,   noise = ${R.model.noise_band}%, weight = ${R.model.growth_weight}
                   (a change inside the noise band is TVL jitter and moves nothing)
maturity         = rises ${R.model.young_floor}→1 over days 0–${R.model.peak_lo_days},
                   holds 1 through day ${R.model.peak_hi_days},
                   decays toward ${R.model.old_floor} after (options dry up, but an old protocol can still drop one)
scarcity         = 1 + (1 − peers/live) × (${R.model.scarcity_max} − 1)   (rarer category, bigger edge)</div>
    <p>Version: <code>${R.model_version}</code> · calibrated from <code>${R.calibration.live_peer_count}</code> live peers · market median <code>${R.calibration.market_multiple.toFixed(2)}×</code></p>
    <table class="cal-table tbl-wrap"><thead><tr><th>Category</th><th>Live peers</th><th>Calibrated base multiple</th></tr></thead>
    <tbody>${cal.map(([c, m]) => `<tr><td>${c}</td><td class="num">${R.calibration.peer_counts[c] ?? 0}</td><td class="num imp">${m.toFixed(2)}×</td></tr>`).join('')}</tbody></table>
  </div>`;
}

// ---------- render & events ----------
function render() {
  document.querySelectorAll('.view').forEach((b) => b.classList.toggle('is-active', b.dataset.view === state.view));
  if (state.view === 'board') main.innerHTML = boardHtml();
  else if (state.view === 'detail') main.innerHTML = detailHtml(state.slug);
  else if (state.view === 'market') main.innerHTML = marketHtml();
  else main.innerHTML = modelHtml();
  wire();
}

// Deep links: #p/<slug> opens a protocol, #market and #model open those views, #q=<text> prefilters
// the board. Every view can be linked to and reloaded on its own.
function readHash() {
  const h = (location.hash || '').replace(/^#/, '');
  if (h.startsWith('p/')) { state.slug = decodeURIComponent(h.slice(2)); state.view = 'detail'; return; }
  if (h === 'market' || h === 'model') { state.view = h; return; }
  if (h.startsWith('q=')) { state.q = decodeURIComponent(h.slice(2)); state.view = 'board'; }
}

function wire() {
  const q = document.getElementById('q');
  if (q) q.addEventListener('input', () => { state.q = q.value; renderBoardOnly(); });
  const cat = document.getElementById('cat');
  if (cat) cat.addEventListener('change', () => { state.cat = cat.value; renderBoardOnly(); });
  const wl = document.getElementById('wlOnly');
  if (wl) wl.addEventListener('click', () => { state.wlOnly = !state.wlOnly; render(); });
  const mt = document.getElementById('minTvl');
  if (mt) mt.addEventListener('input', () => { state.minTvl = mt.value; renderBoardOnly(); });
  document.querySelectorAll('thead th[data-k]').forEach((h) => h.addEventListener('click', () => {
    const k = h.dataset.k;
    if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'name' || k === 'category' ? 1 : -1; }
    render();
  }));
  document.querySelectorAll('tr[data-slug]').forEach((tr) => tr.addEventListener('click', () => { state.slug = tr.dataset.slug; state.view = 'detail'; render(); }));
  const back = document.querySelector('[data-back]');
  if (back) back.addEventListener('click', () => { state.view = 'board'; render(); });
}

function renderBoardOnly() {
  // keep focus in the search box while re-rendering only the table
  const body = document.querySelector('tbody');
  const count = document.getElementById('count');
  if (!body) return render();
  body.innerHTML = rowsHtml();
  if (count) count.textContent = filteredRows().length + ' of ' + R.board_size + ' rows';
  wire();
}

document.querySelectorAll('.view').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  location.hash = state.view === 'board' ? '' : state.view;
  render();
}));
window.addEventListener('hashchange', () => { readHash(); render(); });
readHash();
render();
