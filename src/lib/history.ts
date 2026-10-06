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

import {
  FinMindError,
  fetchPriceHistory,
  fetchInstitutional,
  fetchShareholding,
  fetchMargin,
  type PriceRow,
} from './finmind';

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
  ma10: number | null;
  ma20: number | null;
  /** 季線。不在預設顯示，但留著給想看長期趨勢的人 */
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
  // ── 籌碼面（要多打兩次 API，所以只在切到籌碼副圖時才抓）──
  /** 外資及陸資持股比率(%) */
  foreignRatio: number | null;
  /** 融資餘額（張） */
  marginBalance: number | null;
  /** 融券餘額（張） */
  shortBalance: number | null;
}

/** 一天的籌碼面資料 */
export interface ChipDay {
  foreignRatio: number | null;
  margin: number | null;
  short: number | null;
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

const chipCache = new Map<string, { at: number; byDate: Map<string, ChipDay> }>();

/**
 * 籌碼面：外資持股比率 ＋ 融資融券餘額。
 *
 * 這兩支各要一次呼叫，所以<strong>刻意不在預設路徑上抓</strong>——
 * 只有切到「籌碼」副圖（走網址 ?pane=chips）時才會打。
 * 預設瀏覽維持 2 次呼叫，不為了選用的功能付固定成本。
 *
 * 注意分點買賣超（TaiwanStockTradingDailyReport）與股權分散表
 * （TaiwanStockHoldingSharesPer）在 FinMind 免費層是擋住的，回 HTTP 400。
 * 所以「籌碼集中度」只能用這兩個替代——反而更適合看趨勢：
 * 分點只看得到當天，持股比率看得到十年。
 */
export async function fetchChips(
  stockId: string,
  startDate: string,
): Promise<Map<string, ChipDay>> {
  const hit = chipCache.get(stockId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.byDate;

  const byDate = new Map<string, ChipDay>();
  const touch = (d: string) => {
    let r = byDate.get(d);
    if (!r) byDate.set(d, (r = { foreignRatio: null, margin: null, short: null }));
    return r;
  };

  // 兩支互不相干，一支掛掉不該讓另一支也沒有
  const [sh, mg] = await Promise.allSettled([
    fetchShareholding(stockId, startDate),
    fetchMargin(stockId, startDate),
  ]);
  if (sh.status === 'fulfilled') {
    for (const r of sh.value) {
      const v = Number(r.ForeignInvestmentSharesRatio);
      if (Number.isFinite(v)) touch(r.date).foreignRatio = v;
    }
  }
  if (mg.status === 'fulfilled') {
    for (const r of mg.value) {
      const t = touch(r.date);
      const m = Number(r.MarginPurchaseTodayBalance);
      const sv = Number(r.ShortSaleTodayBalance);
      if (Number.isFinite(m)) t.margin = m;
      if (Number.isFinite(sv)) t.short = sv;
    }
  }
  chipCache.set(stockId, { at: Date.now(), byDate });
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
  chips?: Map<string, ChipDay>,
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
      ma10: sma(closes, i, 10),
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
      foreignRatio: chips?.get(b.date)?.foreignRatio ?? null,
      marginBalance: chips?.get(b.date)?.margin ?? null,
      shortBalance: chips?.get(b.date)?.short ?? null,
    };
  });
}

export const TIMEFRAMES = {
  day: { label: '日線', unit: '日', defaultRange: '1y' },
  week: { label: '週線', unit: '週', defaultRange: '3y' },
  month: { label: '月線', unit: '月', defaultRange: 'all' },
} as const;

export type Timeframe = keyof typeof TIMEFRAMES;

export function isTimeframe(v: string | null): v is Timeframe {
  return v !== null && v in TIMEFRAMES;
}

/**
 * 分組鍵：同一週（或同一月）的交易日會得到同一個鍵。
 *
 * 週用 ISO 週（週一起算），這是台股週線的慣例。
 * 跨年那一週不能直接用「年份 + 週數」硬拼——12/31 可能屬於隔年的第 1 週，
 * 所以先把日期移到該週的週四再取年份，這是 ISO 8601 的標準作法。
 */
function periodKey(date: string, tf: Timeframe): string {
  if (tf === 'month') return date.slice(0, 7);
  const d = new Date(date + 'T00:00:00Z');
  const dow = d.getUTCDay() || 7; // 週日當 7
  d.setUTCDate(d.getUTCDate() + 4 - dow); // 移到該週的週四
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil((d.getTime() - yearStart) / 86_400_000 / 7 + 0.5);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 把日 K 聚合成週 K 或月 K。
 *
 * 開盤取該期第一天、收盤取最後一天、最高最低取區間極值、量與金額加總——
 * 這是 K 線聚合的標準定義。代表日期用<strong>該期最後一個交易日</strong>，
 * 不是週一或月初：這樣最後一根（還沒走完的那週／那月）的日期
 * 就是「資料到哪一天」，跟畫面上的即時報價對得起來。
 */
export function aggregateBars(bars: Bar[], tf: Timeframe): Bar[] {
  if (tf === 'day') return bars;
  const out: Bar[] = [];
  let key = '';
  for (const b of bars) {
    const k = periodKey(b.date, tf);
    if (k !== key) {
      key = k;
      out.push({ ...b });
      continue;
    }
    const cur = out[out.length - 1];
    cur.high = Math.max(cur.high, b.high);
    cur.low = Math.min(cur.low, b.low);
    cur.close = b.close;
    cur.date = b.date;
    cur.volume += b.volume;
    cur.turnover += b.turnover;
  }
  return out;
}

/** 每一期的最後一個交易日，當作這一期的代表日期 */
function lastDates(bars: Bar[], tf: Timeframe): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of bars) m.set(periodKey(b.date, tf), b.date);
  return m;
}

/** 法人買賣超是<strong>流量</strong>，聚合時要加總 */
export function aggregateInst(
  bars: Bar[],
  tf: Timeframe,
  inst: Map<string, InstDay>,
): Map<string, InstDay> {
  if (tf === 'day') return inst;
  const last = lastDates(bars, tf);
  const byKey = new Map<string, InstDay>();
  for (const b of bars) {
    const d = inst.get(b.date);
    if (!d) continue;
    const k = periodKey(b.date, tf);
    let acc = byKey.get(k);
    if (!acc) byKey.set(k, (acc = { foreign: 0, trust: 0, dealer: 0 }));
    acc.foreign += d.foreign;
    acc.trust += d.trust;
    acc.dealer += d.dealer;
  }
  const out = new Map<string, InstDay>();
  for (const [k, acc] of byKey) out.set(last.get(k)!, acc);
  return out;
}

/**
 * 持股比率與融資餘額是<strong>時點</strong>不是流量，所以取該期最後一個有值的，
 * 不能加總——加總會得到一個沒有意義的數字（例如持股比率變成 300%）。
 */
export function aggregateChips(
  bars: Bar[],
  tf: Timeframe,
  chips?: Map<string, ChipDay>,
): Map<string, ChipDay> | undefined {
  if (tf === 'day' || !chips) return chips;
  const last = lastDates(bars, tf);
  const byKey = new Map<string, ChipDay>();
  for (const b of bars) {
    const c = chips.get(b.date);
    if (!c) continue;
    const k = periodKey(b.date, tf);
    const acc = byKey.get(k) ?? { foreignRatio: null, margin: null, short: null };
    if (c.foreignRatio !== null) acc.foreignRatio = c.foreignRatio;
    if (c.margin !== null) acc.margin = c.margin;
    if (c.short !== null) acc.short = c.short;
    byKey.set(k, acc);
  }
  const out = new Map<string, ChipDay>();
  for (const [k, acc] of byKey) out.set(last.get(k)!, acc);
  return out;
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
