/**
 * 個股技術線圖的資料來源與指標計算。
 *
 * 為什麼直接打 FinMind 而不是讀自己的資料庫：
 *   stock_daily 只有收盤價，沒有開高低——畫不出 K 線。
 *   完整 OHLC 在 Parquet 與 FinMind 那邊。把 OHLC 補進資料庫要多上百 MB，
 *   在 Vercel 跑 DuckDB 讀遠端 Parquet 則要帶原生二進位檔、冷啟動很重。
 *   而看線圖是「一次看一檔」，FinMind 一次呼叫就給那一檔十年份，很划算。
 *   這跟 /live 即時報價的作法一致：不落地、要的時候才去拿。
 *
 * 有一層行程內快取，因為同一檔在不同期間之間切換時不該重打 API。
 */

import { fetchPriceHistory, type PriceRow } from './finmind';

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
  /** 主力成本：近 20 / 60 個交易日的成交金額 ÷ 成交股數 */
  cost20: number | null;
  cost60: number | null;
}

/** 一檔快取多久。看線圖通常會連續切換期間，不該每次都重打 */
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; bars: Bar[] }>();

/** 布林通道的參數。20 日 ± 2 倍標準差是最通用的設定 */
const BB_PERIOD = 20;
const BB_SIGMA = 2;

export async function fetchBars(stockId: string, startDate: string): Promise<Bar[]> {
  const hit = cache.get(stockId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.bars;

  const raw: PriceRow[] = await fetchPriceHistory(stockId, startDate);
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
  return bars;
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
 * 算出所有指標。
 *
 * 注意要用「完整的歷史」去算再裁切，不能先裁切再算——
 * 否則畫三個月的圖時，前 60 根都會因為算不出 60 日線而留空。
 */
export function withIndicators(bars: Bar[]): ChartPoint[] {
  const closes = bars.map((b) => b.close);
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
