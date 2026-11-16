// The token radar's model v2: one snapshot in, one calibrated ranked board out.
//
// Improvements over the starter model, all derived from the snapshot itself (never from names):
//
// 1. Calibration from live peers: the snapshot carries protocols whose token already trades
//    (mcap_usd, gecko_id, symbol). Their mcap/tvl ratios ARE the market's own pricing of value
//    per dollar of TVL, bucketed by category. The base multiple for each category is the median
//    ratio of its live peers, falling back to a blended market median, clamped to sane bounds.
// 2. Growth sustain, not just a 7d spike: a change inside the noise band moves the multiplier
//    barely at all; a real move counts with the weight; steep declines are capped.
// 3. Age curve with an issuance clock: value per TVL decays the longer a protocol runs without a
//    token, but very young protocols carry execution risk. The maturity multiplier peaks in a
//    middle band (180..730 days) and tapers on both sides.
// 4. Scarcity edge: within its category, a protocol whose category has few live peers is a rarer
//    airdrop target; a small scarcity multiplier rewards that, computed from category counts.
//
// Every constant is stated in the dashboard; no protocol name is ever special-cased.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Tunable constants, stated in the dashboard and changeable in its model sandbox. */
export interface ModelConstants {
  fallback_multiple: number;
  multiple_min: number;
  multiple_max: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  noise_band: number;
  peak_lo_days: number;
  peak_hi_days: number;
  young_floor: number;
  old_floor: number;
  unknown_age_days: number;
  scarcity_max: number;
  early_rows: number;
  live_rows: number;
}

export const MODEL_VERSION = 'radar-v2-calibrated';

export const MODEL: ModelConstants = {
  fallback_multiple: 0.35,
  multiple_min: 0.08,
  multiple_max: 3.5,
  growth_weight: 0.55,
  growth_floor: -60,
  growth_cap: 120,
  noise_band: 1.5,
  peak_lo_days: 180,
  peak_hi_days: 730,
  young_floor: 0.75,
  old_floor: 0.55,
  unknown_age_days: 400,
  scarcity_max: 1.18,
  early_rows: 120,
  live_rows: 60,
};

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of an array of numbers; null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/**
 * The market's own pricing: for each category, the median mcap/tvl ratio of its live-token peers
 * at or above $10M TVL. Categories with no peers fall back to the market-wide median, and every
 * base multiple is clamped to sane bounds.
 */
export interface Calibration {
  category_multiples: Record<string, number>;
  market_multiple: number;
  peer_counts: Record<string, number>;
  live_peer_count: number;
}

export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.tvl_usd >= 10_000_000 && p.mcap_usd !== null && p.mcap_usd > 0);
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of live) {
    const r = (p.mcap_usd as number) / p.tvl_usd;
    if (!Number.isFinite(r) || r <= 0) continue;
    all.push(r);
    const c = p.category ?? 'Uncategorized';
    const list = byCategory.get(c) ?? [];
    list.push(r);
    byCategory.set(c, list);
  }
  const market = median(all) ?? model.fallback_multiple;
  const category_multiples: Record<string, number> = {};
  const peer_counts: Record<string, number> = {};
  for (const [c, ratios] of byCategory) {
    const m = median(ratios) ?? market;
    category_multiples[c] = Math.min(model.multiple_max, Math.max(model.multiple_min, m));
    peer_counts[c] = ratios.length;
  }
  return { category_multiples, market_multiple: market, peer_counts, live_peer_count: live.length };
}

/** The calibrated base multiple for one protocol's category. */
export function baseMultiple(p: SnapshotProtocol, cal: Calibration, model: ModelConstants): number {
  const c = p.category ?? 'Uncategorized';
  if (cal.category_multiples[c] !== undefined) return cal.category_multiples[c]!;
  return Math.min(model.multiple_max, Math.max(model.multiple_min, cal.market_multiple));
}

/**
 * Growth multiplier with a noise floor: changes inside the band move the multiplier barely at all
 * (TVL jitters), real moves count with the weight, and steep declines are capped.
 */
export function growthMultiplier(p: SnapshotProtocol, model: ModelConstants): { mult: number; pct: number } {
  const raw = finite(p.change_7d, 0); // snapshot already stores percent
  const pct = Math.min(model.growth_cap, Math.max(model.growth_floor, raw));
  const sign = pct >= 0 ? 1 : -1;
  const magnitude = Math.abs(pct);
  const effective = magnitude <= model.noise_band ? 0 : magnitude - model.noise_band;
  const mult = 1 + sign * (effective / 100) * model.growth_weight;
  return { mult, pct: Math.round(pct * 10) / 10 };
}

/**
 * Maturity multiplier with an issuance clock: rises from the young floor to 1.0 across the first
 * band, holds its peak through the second band, then decays toward the old floor. Unknown age sits
 * mid-curve.
 */
export function maturityMultiplier(age: number | null, model: ModelConstants): number {
  const days = age ?? model.unknown_age_days;
  if (days < model.peak_lo_days) {
    const t = days / model.peak_lo_days;
    return model.young_floor + (1 - model.young_floor) * t;
  }
  if (days <= model.peak_hi_days) return 1;
  const over = days - model.peak_hi_days;
  const decay = Math.min(1, over / (model.peak_hi_days * 2));
  return 1 - decay * (1 - model.old_floor);
}

/**
 * Scarcity multiplier: a category with few live peers but real TVL is a rarer target. Computed
 * from the category's live-peer count alone.
 */
export function scarcityMultiplier(p: SnapshotProtocol, cal: Calibration, model: ModelConstants): number {
  const c = p.category ?? 'Uncategorized';
  const peers = cal.peer_counts[c] ?? 0;
  if (peers === 0) return 1;
  const rarity = Math.max(0, 1 - peers / cal.live_peer_count);
  return 1 + rarity * (model.scarcity_max - 1);
}

/** The multipliers and the implied value one protocol gets under the model. */
export function impliedValue(p: SnapshotProtocol, asOf: string, cal: Calibration, model: ModelConstants = MODEL): { implied: number; growthPct: number; growthMult: number; maturityMult: number; scarcityMult: number; base: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const base = p.tvl_usd * baseMultiple(p, cal, model);
  const { mult: growthMult, pct: growthPct } = growthMultiplier(p, model);
  const maturityMult = maturityMultiplier(age, model);
  const scarcityMult = scarcityMultiplier(p, cal, model);
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * scarcityMult));
  return { implied, growthPct, growthMult, maturityMult, scarcityMult, base, age };
}

/** A row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    scarcity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A live-token protocol row for the dashboard's market view. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl_ratio: number | null;
}

export interface FarmStep { text: string; cost: string; time: string }

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, cal: Calibration, model: ModelConstants = MODEL): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, model.early_rows);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, cal, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: round4(s.base / Math.max(1, s.p.tvl_usd)),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      scarcity_multiplier: round4(s.scarcityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow against half of it and repay the borrow once.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s largest pool on ${chain} and leave a second small swap through the same pool.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside its app once.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the liquid receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name}, open one small position, then close it.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market and one opposite position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and hold the shares for the full window.`;
  if (c.includes('stable')) return `Mint $${capital} of the stable asset through ${name} on ${chain}, redeem a third, and mint again.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it across a full epoch.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy through expiry.`;
  if (c.includes('basis')) return `Open the basis trade ${name} automates with $${capital}: spot long, perp short, one full round trip.`;
  if (c.includes('payment')) return `Send $${capital} through a ${name} payment route on ${chain}, then send a second smaller one.`;
  if (c.includes('governance')) return `Deposit $${capital} into ${name}'s incentive pool on ${chain} and vote on one proposal.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven concrete steps, each an action with a cost and a time, derived
 * from the protocol's own record (category, chains, TVL, age) — never from a list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const perp = (p.category ?? '').toLowerCase().includes('perpetual');
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    { text: action, cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
    {
      text: `Make one qualifying action each week — a deposit, a borrow, a swap, a vote or${perp ? ' one closed trade' : ' a liquidity add'} — from the same wallet.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position at least ${hold} days so the wallet is counted in several weekly snapshots${age !== null && age > 730 ? ' — the protocol has run long without a token, so an airdrop can land any month' : ''}.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Track the wallet's volume against the level other farmers report on the protocol's own points page, and top up if it sits in the bottom band.`,
      cost: 'no fee to check',
      time: '15 minutes a month',
    },
    {
      text: `Claim only from the protocol's own page once a token or points redemption appears; never pay a third party to claim.`,
      cost: 'no fee, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so the position can be repeated or unwound without guessing.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's market view. */
export function liveRows(snapshot: Snapshot, model: ModelConstants = MODEL): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, model.live_rows)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl_ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): Record<string, unknown> {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    scarcity_multiplier: row.model.scarcity_multiplier,
    base_multiple: row.model.base_multiple,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: Record<string, unknown>[];
  live: LiveRow[];
}

export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const cal = calibrate(snapshot, model);
  const board = buildBoard(snapshot, cal, model);
  const live = liveRows(snapshot, model);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration: cal,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, spread, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
