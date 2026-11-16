/** Input protocol shape used by the snapshot feed. */
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

/** A point-in-time collection of protocol data and requested watchlist slugs. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface BoardRow extends SnapshotProtocol {
  rank: number;
  age_days: number;
  peer: number;
  momentum: number;
  seasoning: number;
  discount: number;
  breadth: number;
  implied_value_usd: number;
  confidence: "A" | "B" | "C";
  token_status: "pre-token";
  farm_steps: string[];
}

export type Board = BoardRow[];

export interface RadarRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  age_days: number;
  peer: number;
  momentum: number;
  seasoning: number;
  discount: number;
  breadth: number;
  confidence: "A" | "B" | "C";
}

export type LiveRow = SnapshotProtocol;

export interface Radar {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: "peer-anchor-1";
  constants: {
    minimum_peer: number;
    maximum_peer: number;
    peer_shrinkage_sample_size: number;
    momentum_weight: number;
    momentum_change_divisor: number;
    minimum_momentum_change: number;
    maximum_momentum_change: number;
    seasoning_base: number;
    seasoning_weight: number;
    seasoning_days: number;
    discount_threshold_usd: number;
    discount_weight: number;
    breadth_weight: number;
    maximum_breadth_chains: number;
    minimum_implied_value_usd: number;
  };
  counts: {
    protocols: number;
    rankable: number;
    watchlist: number;
    board: number;
    live: number;
  };
  rows: RadarRow[];
  live_rows: LiveRow[];
}

const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validDate(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

/**
 * Parse the feed and reject incomplete or ill-typed snapshots rather than
 * allowing malformed data to silently affect ranks.
 */
export function parseSnapshot(text: string): Snapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Malformed snapshot JSON");
  }

  if (!isRecord(value)
    || !isString(value.as_of)
    || !validDate(value.as_of)
    || !isString(value.source)
    || !isFiniteNumber(value.floor_usd)
    || value.floor_usd < 0
    || !Array.isArray(value.protocols)
    || !Array.isArray(value.watchlist)
    || !value.watchlist.every(isString)) {
    throw new Error("Malformed snapshot");
  }

  const slugs = new Set<string>();
  const protocols: SnapshotProtocol[] = [];
  for (const candidate of value.protocols) {
    if (!isRecord(candidate)
      || !isString(candidate.slug)
      || !isString(candidate.name)
      || !isNullableString(candidate.category)
      || !Array.isArray(candidate.chains)
      || !candidate.chains.every(isString)
      || !isFiniteNumber(candidate.tvl_usd)
      || candidate.tvl_usd < 0
      || !(candidate.change_7d === null || isFiniteNumber(candidate.change_7d))
      || !(candidate.mcap_usd === null
        || isFiniteNumber(candidate.mcap_usd))
      || !isNullableString(candidate.listed_at)
      || (candidate.listed_at !== null && !validDate(candidate.listed_at))
      || !isNullableString(candidate.gecko_id)
      || !isNullableString(candidate.symbol)
      || slugs.has(candidate.slug)) {
      throw new Error("Malformed snapshot protocol");
    }

    slugs.add(candidate.slug);
    protocols.push({
      slug: candidate.slug,
      name: candidate.name,
      category: candidate.category,
      chains: [...candidate.chains],
      tvl_usd: candidate.tvl_usd,
      change_7d: candidate.change_7d,
      mcap_usd: candidate.mcap_usd !== null && candidate.mcap_usd <= 0
        ? null
        : candidate.mcap_usd,
      listed_at: candidate.listed_at,
      gecko_id: candidate.gecko_id,
      symbol: candidate.symbol,
    });
  }

  return {
    as_of: value.as_of,
    source: value.source,
    floor_usd: value.floor_usd,
    protocols,
    watchlist: [...value.watchlist],
  };
}

function isPreToken(protocol: SnapshotProtocol): boolean {
  return protocol.mcap_usd === null
    && protocol.gecko_id === null
    && protocol.symbol === null;
}

function isRankable(protocol: SnapshotProtocol): boolean {
  return isPreToken(protocol)
    && (protocol.category === null || !EXCLUDED_CATEGORIES.has(protocol.category))
    && !VERSION_MARKER.test(protocol.name)
    && !/\b(wrapped|staked|staking)\b/i.test(protocol.name);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compareSlugs(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Category estimates are shrunk toward the global median until they have eight
// tokenized peers, then bounded so outlier comparables cannot dominate a score.
function peerMultiples(snapshot: Snapshot): {
  global: number;
  byCategory: Map<string, { median: number; count: number }>;
} {
  const globalRatios: number[] = [];
  const categoryRatios = new Map<string, number[]>();
  for (const protocol of snapshot.protocols) {
    if (protocol.mcap_usd === null || protocol.mcap_usd <= 0 || protocol.tvl_usd <= 0) continue;
    const ratio = protocol.mcap_usd / protocol.tvl_usd;
    if (!Number.isFinite(ratio)) continue;
    globalRatios.push(ratio);
    if (protocol.category !== null) {
      const ratios = categoryRatios.get(protocol.category) ?? [];
      ratios.push(ratio);
      categoryRatios.set(protocol.category, ratios);
    }
  }

  const byCategory = new Map<string, { median: number; count: number }>();
  for (const [category, ratios] of categoryRatios) {
    byCategory.set(category, { median: median(ratios), count: ratios.length });
  }
  return { global: median(globalRatios), byCategory };
}

function peerFor(
  category: string | null,
  multiples: ReturnType<typeof peerMultiples>,
): number {
  const globalMedian = multiples.global;
  const categoryData = category === null ? undefined : multiples.byCategory.get(category);
  let peer = globalMedian;
  if (categoryData !== undefined) {
    const sampleSize = 8;
    peer = (
      categoryData.count * categoryData.median
      + Math.max(0, sampleSize - categoryData.count) * globalMedian
    ) / Math.max(categoryData.count, sampleSize);
  }
  return Math.min(1.5, Math.max(0.03, peer));
}

function ageDays(listedAt: string, asOf: string): number {
  return Math.max(0, (Date.parse(asOf) - Date.parse(listedAt)) / DAY_MS);
}

function calculateAgeMedian(protocols: SnapshotProtocol[], asOf: string): number {
  return median(protocols
    .flatMap((protocol) => protocol.listed_at === null
      ? []
      : [ageDays(protocol.listed_at, asOf)]));
}

function capitalTier(tvlUsd: number): number {
  if (tvlUsd >= 5e9) return 250;
  if (tvlUsd >= 1e9) return 150;
  if (tvlUsd >= 1e8) return 100;
  if (tvlUsd >= 1e7) return 50;
  return 25;
}

function holdDays(age: number | null): number {
  if (age === null || !Number.isFinite(age)) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

function dollars(amount: number): string {
  return `$${amount.toFixed(2).replace(/\.?0+$/, "")}`;
}

function categoryAction(category: string | null, chain: string): string {
  const normalized = category?.trim().toLowerCase() ?? "";
  if (["lending", "cdp", "collateral"].includes(normalized)) {
    return `Supply USDC to the protocol on ${chain}`;
  }
  if (["dexs", "dex", "yield", "leveraged farming", "liquidity"].includes(normalized)) {
    return `Provide liquidity to the protocol's main pool on ${chain}`;
  }
  if (["derivatives", "perps"].includes(normalized)) {
    return `Deposit margin and open one small hedge on ${chain}`;
  }
  if (["staking", "restaking", "liquid staking", "liquid restaking"].includes(normalized)) {
    return `Stake the chain asset through the protocol on ${chain}`;
  }
  if (["risk curators", "allocator", "vault"].includes(normalized)) {
    return `Deposit into a protocol vault on ${chain} and keep the shares`;
  }
  if (normalized === "rwa") {
    return `Mint or hold the protocol's yield asset on ${chain}`;
  }
  if (normalized === "insurance") {
    return `Buy protocol cover on ${chain}`;
  }
  if (["payments", "stablecoin"].includes(normalized)) {
    return `Mint or deposit the protocol's stable asset on ${chain}`;
  }
  return `Deposit USDC into the protocol on ${chain} and keep the position open`;
}

/**
 * Give each candidate a concrete, tier-sized action plan with explicit dollar
 * costs and time commitments; an unknown age uses the middle hold period.
 */
export function farmSteps(protocol: SnapshotProtocol, ageDays: number | null): string[] {
  const capital = capitalTier(protocol.tvl_usd);
  const quarter = dollars(capital / 4);
  const chain = protocol.chains[0] ?? "the first listed chain";
  const secondChain = protocol.chains[1];
  const hold = holdDays(ageDays);
  const stepTwoAction = categoryAction(protocol.category, chain);
  const stepThreeAction = secondChain === undefined
    ? `Add ${quarter} to the step-2 position on ${chain}`
    : `Repeat the step-2 action on ${secondChain} using ${quarter}`;

  return [
    `Create a fresh wallet holding only farm funds and store its seed phrase offline. Cost: under $3 of gas. Time: 5 minutes.`,
    `${stepTwoAction}. Cost: ${dollars(capital)} capital plus a few dollars of gas. Time: 15 minutes.`,
    `${stepThreeAction}. Cost: ${quarter} capital plus a few dollars of gas. Time: 15 minutes.`,
    "Complete one qualifying deposit, borrow, swap, or vote on the protocol each week. Cost: about $2 of gas a week. Time: 10 minutes a week.",
    `Keep the position open for at least ${hold} days so activity spans several snapshots. Cost: ${dollars(capital)} capital staying in place. Time: ${hold} days.`,
    "Check the protocol's own points or rewards page, entering only from the link on its official site, and never pay anyone to claim. Cost: nothing to check. Time: 10 minutes.",
    "Keep a farm log of the wallet, dates, transactions, and costs, and set a review date to unwind or repeat. Cost: nothing. Time: 5 minutes.",
  ];
}

function scoreProtocol(
  protocol: SnapshotProtocol,
  snapshot: Snapshot,
  multiples: ReturnType<typeof peerMultiples>,
  imputedAge: number,
): Omit<BoardRow, "rank" | "farm_steps"> {
  const age = protocol.listed_at === null
    ? imputedAge
    : ageDays(protocol.listed_at, snapshot.as_of);
  const peer = peerFor(protocol.category, multiples);
  // Independent adjustments keep momentum, seasoning, size, and chain breadth
  // visible in every row so the estimate can be audited.
  const momentum = protocol.change_7d === null
    ? 1
    : 1 + 0.35 * Math.tanh(Math.min(100, Math.max(-50, protocol.change_7d)) / 25);
  const seasoning = 0.55 + 0.45 * (1 - Math.exp(-age / 540));
  const discount = protocol.tvl_usd > 1e8
    ? 1 / (1 + 0.06 * Math.log10(protocol.tvl_usd / 1e8))
    : 1;
  const breadth = Math.max(1, 1 + 0.02 * Math.min(protocol.chains.length - 1, 5));
  const implied_value_usd = Math.max(
    1000,
    Math.round(protocol.tvl_usd * peer * momentum * seasoning * discount * breadth),
  );
  const confidence = protocol.listed_at !== null && protocol.change_7d !== null
    ? age >= 365 ? "A" : "B"
    : "C";
  return {
    ...protocol,
    age_days: age,
    peer,
    momentum,
    seasoning,
    discount,
    breadth,
    implied_value_usd,
    confidence,
    token_status: "pre-token",
  };
}

/** Score candidates and watchlisted pre-token protocols into a stable board. */
export function buildBoard(snapshot: Snapshot): Board {
  const multiples = peerMultiples(snapshot);
  const rankable = snapshot.protocols.filter(isRankable);
  const imputedAge = calculateAgeMedian(rankable, snapshot.as_of);
  const watchlist = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter((protocol) =>
    isPreToken(protocol) && (isRankable(protocol) || watchlist.has(protocol.slug)));

  return candidates
    .map((protocol) => {
      const scored = scoreProtocol(protocol, snapshot, multiples, imputedAge);
      return {
        ...scored,
        rank: 0,
        farm_steps: farmSteps(protocol, scored.age_days),
      };
    })
    .sort((a, b) =>
      b.implied_value_usd - a.implied_value_usd || compareSlugs(a.slug, b.slug))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

/** Check the ordered release gates; return the first actionable issue. */
export function boardIssue(board: Board, snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((row) => row.slug));
  const missingSlug = snapshot.watchlist.find((slug) => !slugs.has(slug));
  if (missingSlug !== undefined) return `Missing watchlist slug: ${missingSlug}`;

  if (board.some((row, index) => row.rank !== index + 1)) {
    return "Ranks are not exactly 1..N";
  }
  for (let index = 1; index < board.length; index += 1) {
    if (board[index].implied_value_usd > board[index - 1].implied_value_usd) {
      return "Implied value rises with rank";
    }
  }
  if (board.length > 1 && board.every(
    (row) => row.implied_value_usd === board[0].implied_value_usd,
  )) {
    return "All implied values are equal";
  }
  for (const row of board) {
    if (!Array.isArray(row.farm_steps)
      || row.farm_steps.length < 3
      || row.farm_steps.length > 12
      || row.farm_steps.some((step) =>
        typeof step !== "string" || step.length < 20 || step.length > 600)) {
      return `Invalid farm_steps for ${row.slug}`;
    }
  }
  return null;
}

/** Tokenized protocols appear only in the separate comparables list. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const priced = snapshot.protocols
    .filter((protocol) => protocol.mcap_usd !== null && protocol.mcap_usd > 0)
    .sort((a, b) => {
      const left = a.mcap_usd ?? 0;
      const right = b.mcap_usd ?? 0;
      return right - left || compareSlugs(a.slug, b.slug);
    })
    .slice(0, 24);
  const unpricedTokenized = snapshot.protocols
    .filter((protocol) =>
      (protocol.mcap_usd === null || protocol.mcap_usd <= 0)
      && (protocol.gecko_id !== null || protocol.symbol !== null))
    .sort((a, b) => compareSlugs(a.slug, b.slug));
  return [...priced, ...unpricedTokenized]
    .map((protocol) => ({ ...protocol, chains: [...protocol.chains] }));
}

/** Produce the board and its compact serialized presentation model. */
export function buildRadar(snapshot: Snapshot): { board: Board; radar: Radar } {
  const board = buildBoard(snapshot);
  const rankableCount = snapshot.protocols.filter(isRankable).length;
  const live = liveRows(snapshot);
  const radar: Radar = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: "peer-anchor-1",
    constants: {
      minimum_peer: 0.03,
      maximum_peer: 1.5,
      peer_shrinkage_sample_size: 8,
      momentum_weight: 0.35,
      momentum_change_divisor: 25,
      minimum_momentum_change: -50,
      maximum_momentum_change: 100,
      seasoning_base: 0.55,
      seasoning_weight: 0.45,
      seasoning_days: 540,
      discount_threshold_usd: 1e8,
      discount_weight: 0.06,
      breadth_weight: 0.02,
      maximum_breadth_chains: 5,
      minimum_implied_value_usd: 1000,
    },
    counts: {
      protocols: snapshot.protocols.length,
      rankable: rankableCount,
      watchlist: snapshot.watchlist.length,
      board: board.length,
      live: live.length,
    },
    rows: board.map((row) => ({
      slug: row.slug,
      name: row.name,
      rank: row.rank,
      implied_value_usd: row.implied_value_usd,
      age_days: row.age_days,
      peer: row.peer,
      momentum: row.momentum,
      seasoning: row.seasoning,
      discount: row.discount,
      breadth: row.breadth,
      confidence: row.confidence,
    })),
    live_rows: live,
  };
  return { board, radar };
}

/** Safely embed the deterministic radar payload as an inline script value. */
export function dataScript(radar: Radar): string {
  const json = JSON.stringify(radar)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return `window.RADAR=${json};\n`;
}
