/**
 * 個股技術線圖的資料來源與指標計算。
 *
 * 為什麼直接打 FinMind 而不是讀自己的資料庫：
 *   stock_daily 只有收盤價，沒有開高低——畫不出 K 線。
 *
 *   補進資料庫的成本不在「欄位」而在「保留期間」：加三個 OHLC 欄位到現有的
 *   459,847 列只要約 12 MB，但 stock_daily 為了省容量只留「月底 120 期 ＋
 *   近 61 個交易日」，所以畫出來的 K 線只有最近三個月是連續的。
 *   要連續一年得把保留期間拉到 250 天，那是 +57 萬列、約 +110 MB，
 *   會把 2.9 年的容量餘裕吃掉大半。
 *
 *   而且看線圖本來就是「一次看一檔」——為了偶爾看的那幾檔，
 *   去存 3,007 檔的逐日 OHLC，比例完全不對。
 *   實測 FinMind 一次呼叫 276~414 ms 就拿到十年 2,865 列，
 *   這個延遲在畫面上感覺不出來。所以跟 /live 一樣：不落地，要的時候才去拿。
 *
 * 有一層行程內快取，因為同一檔在不同期間之間切換時不該重打 API。
 */

import { FinMindError, fetchPriceHistory, fetchInstitutional, type PriceRow } from './finmind';

export interface Bar {
  /** YYYY-MM-DD */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 成交股數 */
  volume: number;
  /** 成交金額（元） */
  turnover: number;
}

export interface ChartPoint extends Bar {
  /** 當日成交均價＝成交金額 ÷ 成交股數。比收盤價更能代表當天的實際成交水準 */
  vwap: number | null;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  /** 布林通道：中軌（＝ma20）、上軌、下軌 */
  bbUpper: number | null;
  bbLower: number | null;
  /** 市場成本：近 20 / 60 個交易日的成交金額 ÷ 成交股數（全市場加權均價） */
  cost20: number | null;
  cost60: number | null;
  /** 外資／投信近 20 日的買超加權均價。這才是真正的「主力成本」 */
  foreignCost20: number | null;
  trustCost20: number | null;
  /** 當日淨買超（張）。正數是買超 */
  foreignNet: number | null;
  trustNet: number | null;
  dealerNet: number | null;
  /** 近 20 日累計淨買超（張） */
  foreignNet20: number | null;
  // ── 震盪指標 ──
  /** KD(9,3,3) */
  k: number | null;
  d: number | null;
  /** RSI(14) */
  rsi: number | null;
  /** MACD(12,26,9)：DIF、訊號線、柱狀 */
  dif: number | null;
  dem: number | null;
  osc: number | null;
}

/** 一天的法人買賣超，已歸類成台股習慣的三類（單位：股） */
export interface InstDay {
  foreign: number;
  trust: number;
  dealer: number;
}

/** 一檔快取多久。看線圖通常會連續切換期間，不該每次都重打 */
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; bars: Bar[] }>();

/** 布林通道的參數。20 日 ± 2 倍標準差是最通用的設定 */
const BB_PERIOD = 20;
const BB_SIGMA = 2;

/**
 * 為什麼要分三種結果而不是一律回空陣列：
 *   「這檔沒有交易資料」與「額度用完了拿不到」在畫面上長得一樣，
 *   但使用者該做的事完全不同——前者沒救，後者等一下重整就好。
 *   把錯誤吞掉會讓人以為是資料有問題，其實只是暫時拿不到。
 */
export type BarsResult =
  | { ok: true; bars: Bar[] }
  | { ok: false; reason: 'quota' | 'upstream'; message: string };

export async function fetchBars(stockId: string, startDate: string): Promise<BarsResult> {
  const hit = cache.get(stockId);
  if (hit && Date.now() - hit.at < TTL_MS) return { ok: true, bars: hit.bars };

  let raw: PriceRow[];
  try {
    raw = await fetchPriceHistory(stockId, startDate);
  } catch (e) {
    // 402 / 429 是 FinMind 的額度用盡，跟「查不到這檔」是兩回事
    const quota = e instanceof FinMindError && (e.status === 402 || e.status === 429);
    return {
      ok: false,
      reason: quota ? 'quota' : 'upstream',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  const bars: Bar[] = [];
  for (const r of raw) {
    const open = Number(r.open);
    const high = Number(r.max);
    const low = Number(r.min);
    const close = Number(r.close);
    // 停牌日會給 0 或缺值。畫進去會變成一根插到底的假 K 棒，直接跳過
    if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) continue;
    bars.push({
      date: r.date,
      open,
      high,
      low,
      close,
      volume: Number(r.Trading_Volume) || 0,
      turnover: Number(r.Trading_money) || 0,
    });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  cache.set(stockId, { at: Date.now(), bars });
  return { ok: true, bars };
}

const instCache = new Map<string, { at: number; byDate: Map<string, InstDay> }>();

/**
 * 三大法人買賣超，整理成「日期 → 三類淨買超（股）」。
 *
 * 上游一天給五列（外資、外資自營、投信、自營自行、自營避險），
 * 這裡依台股習慣併成三類。抓不到就回空 Map——法人資料缺漏
 * 不該讓整張線圖掛掉，K 線本身跟它無關。
 */
export async function fetchInstMap(
  stockId: string,
  startDate: string,
): Promise<Map<string, InstDay>> {
  const hit = instCache.get(stockId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.byDate;

  const byDate = new Map<string, InstDay>();
  try {
    for (const r of await fetchInstitutional(stockId, startDate)) {
      const net = (Number(r.buy) || 0) - (Number(r.sell) || 0);
      let d = byDate.get(r.date);
      if (!d) byDate.set(r.date, (d = { foreign: 0, trust: 0, dealer: 0 }));
      if (r.name === 'Foreign_Investor' || r.name === 'Foreign_Dealer_Self') d.foreign += net;
      else if (r.name === 'Investment_Trust') d.trust += net;
      else if (r.name === 'Dealer_self' || r.name === 'Dealer_Hedging') d.dealer += net;
    }
  } catch {
    // 法人資料沒拿到就留空，線圖其餘部分照常
  }
  instCache.set(stockId, { at: Date.now(), byDate });
  return byDate;
}

/** 簡單移動平均。不足期數回 null，不要拿 3 天的平均去充當 20 日線 */
function sma(values: number[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) sum += values[k];
  return sum / n;
}

/**
 * 加權平均成本：區間內的成交金額總和 ÷ 成交股數總和。
 *
 * 這是「這段期間所有成交的平均價位」，不是收盤價的平均——
 * 量大的那幾天會自然佔比較重，所以比均線更接近「市場的持有成本」。
 *
 * 真正的主力成本要有法人／分點買賣超才算得準，那是付費資料。
 * 這裡用全市場的加權成本當近似，至少分母分子都是官方數字，算式也看得見。
 */
function weightedCost(bars: Bar[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  let money = 0;
  let shares = 0;
  for (let k = i - n + 1; k <= i; k++) {
    money += bars[k].turnover;
    shares += bars[k].volume;
  }
  return shares > 0 ? money / shares : null;
}

/** 母體標準差。布林通道用的是母體不是樣本，差別在分母是 n 還是 n−1 */
function stdev(values: number[], i: number, n: number, mean: number): number {
  let acc = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const d = values[k] - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / n);
}

/**
 * 指數移動平均。種子用前 n 筆的簡單平均，這是最通用的作法
 * （有些軟體直接用第一筆當種子，前幾十根會略有差異，但很快就收斂）。
 */
function emaSeries(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * KD(9,3,3)。台股最常看的震盪指標。
 *
 * RSV = (收盤 − 9日最低) ÷ (9日最高 − 9日最低) × 100
 * K = 2/3 × 前一日K + 1/3 × RSV，D 再對 K 做一次同樣的平滑。
 * K、D 的種子都用 50——這是台股軟體的慣例。
 *
 * 9 日最高最低用的是「最高價的最高」與「最低價的最低」，不是收盤價。
 */
function kdSeries(bars: Bar[], period = 9): { k: (number | null)[]; d: (number | null)[] } {
  const k: (number | null)[] = new Array(bars.length).fill(null);
  const d: (number | null)[] = new Array(bars.length).fill(null);
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i + 1 < period) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].high > hi) hi = bars[j].high;
      if (bars[j].low < lo) lo = bars[j].low;
    }
    // 九天完全沒波動（漲停鎖死之類）時分母為零，沿用前一日的 RSV 觀念取 50
    const rsv = hi > lo ? ((bars[i].close - lo) / (hi - lo)) * 100 : 50;
    prevK = (2 / 3) * prevK + (1 / 3) * rsv;
    prevD = (2 / 3) * prevD + (1 / 3) * prevK;
    k[i] = prevK;
    d[i] = prevD;
  }
  return { k, d };
}

/**
 * RSI(14)，用 Wilder 的平滑法（不是單純的移動平均）。
 *
 * 前 14 天先取平均漲幅與平均跌幅當種子，之後
 *   avg = (前一日avg × 13 + 當日值) ÷ 14
 * 這是 RSI 的原始定義，跟多數看盤軟體一致。
 */
function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * 法人買超加權均價＝真正的「主力成本」。
 *
 * 近 n 日裡「有淨買超的那幾天」，用當日淨買超股數當權重去加權當日均價：
 *   Σ(淨買超 × 當日均價) ÷ Σ(淨買超)
 *
 * 只算買超日是刻意的——這一條回答的是「他們是在什麼價位買進的」。
 * 把賣超日也算進去會變成買賣相抵後的殘值，失去成本的意義。
 * 區間內完全沒買超就回 null，不要硬給一個數字。
 */
function instCost(
  bars: Bar[],
  net: number[],
  i: number,
  n: number,
): number | null {
  if (i + 1 < n) return null;
  let money = 0;
  let shares = 0;
  for (let j = i - n + 1; j <= i; j++) {
    if (net[j] <= 0) continue;
    const b = bars[j];
    const vwap = b.volume > 0 ? b.turnover / b.volume : b.close;
    money += net[j] * vwap;
    shares += net[j];
  }
  return shares > 0 ? money / shares : null;
}

/**
 * 算出所有指標。
 *
 * 注意要用「完整的歷史」去算再裁切，不能先裁切再算——
 * 否則畫三個月的圖時，前 60 根都會因為算不出 60 日線而留空。
 */
export function withIndicators(
  bars: Bar[],
  inst?: Map<string, InstDay>,
): ChartPoint[] {
  const closes = bars.map((b) => b.close);

  // 法人淨買超對齊到 K 棒的日期；沒有法人資料的日子算 0
  const fNet = bars.map((b) => inst?.get(b.date)?.foreign ?? 0);
  const tNet = bars.map((b) => inst?.get(b.date)?.trust ?? 0);
  const dNet = bars.map((b) => inst?.get(b.date)?.dealer ?? 0);
  const hasInst = Boolean(inst && inst.size > 0);

  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const dif = closes.map((_, i) =>
    ema12[i] !== null && ema26[i] !== null ? (ema12[i] as number) - (ema26[i] as number) : null,
  );
  // 訊號線是 DIF 的 9 日 EMA，所以要先把 DIF 還沒成形的前段切掉再算
  const difStart = dif.findIndex((v) => v !== null);
  const demTail = difStart < 0 ? [] : emaSeries(dif.slice(difStart) as number[], 9);
  const dem = closes.map((_, i) =>
    difStart >= 0 && i >= difStart ? demTail[i - difStart] : null,
  );

  const { k, d: dLine } = kdSeries(bars);
  const rsi = rsiSeries(closes);

  return bars.map((b, i) => {
    const ma20 = sma(closes, i, BB_PERIOD);
    let bbUpper: number | null = null;
    let bbLower: number | null = null;
    if (ma20 !== null) {
      const sd = stdev(closes, i, BB_PERIOD, ma20);
      bbUpper = ma20 + BB_SIGMA * sd;
      bbLower = ma20 - BB_SIGMA * sd;
    }
    return {
      ...b,
      vwap: b.volume > 0 ? b.turnover / b.volume : null,
      ma5: sma(closes, i, 5),
      ma20,
      ma60: sma(closes, i, 60),
      bbUpper,
      bbLower,
      cost20: weightedCost(bars, i, 20),
      cost60: weightedCost(bars, i, 60),
      foreignCost20: hasInst ? instCost(bars, fNet, i, 20) : null,
      trustCost20: hasInst ? instCost(bars, tNet, i, 20) : null,
      // 畫面上用「張」，上游給的是「股」
      foreignNet: hasInst ? fNet[i] / 1000 : null,
      trustNet: hasInst ? tNet[i] / 1000 : null,
      dealerNet: hasInst ? dNet[i] / 1000 : null,
      foreignNet20:
        hasInst && i >= 19
          ? fNet.slice(i - 19, i + 1).reduce((a, v) => a + v, 0) / 1000
          : null,
      k: k[i],
      d: dLine[i],
      rsi: rsi[i],
      dif: dif[i],
      dem: dem[i],
      osc: dif[i] !== null && dem[i] !== null ? (dif[i] as number) - (dem[i] as number) : null,
    };
  });
}

export const RANGES = {
  '3m': { label: '近 3 月', days: 90 },
  '6m': { label: '近 6 月', days: 180 },
  '1y': { label: '近 1 年', days: 365 },
  '3y': { label: '近 3 年', days: 365 * 3 },
  all: { label: '全部', days: 0 },
} as const;

export type RangeKey = keyof typeof RANGES;

export function isRangeKey(v: string | null): v is RangeKey {
  return v !== null && v in RANGES;
}

/** 依期間裁切。指標已經用完整歷史算過了，這裡只是決定畫哪一段 */
export function sliceRange(points: ChartPoint[], range: RangeKey): ChartPoint[] {
  const days = RANGES[range].days;
  if (days === 0) return points;
  const cut = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const from = points.findIndex((p) => p.date >= cut);
  return from < 0 ? points.slice(-1) : points.slice(from);
}
