/**
 * 證交所 MIS 即時報價。
 *
 * 跟 stock_daily 刻意分開，資料不進資料庫：
 *   stock_daily 的語意是「當日收盤」，把盤中價寫進去會讓歷史資料失去意義
 *   （同一個 trade_date 會因為查詢時間不同而有不同的值）。
 *
 * 實測（2026-09-29 盤中）：
 *   - 免 token、一次可查 60 檔，全市場約 50 次呼叫
 *   - 資料約延遲 20 秒
 *   - 一定要帶 Referer，否則會被擋
 */

const MIS_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';

/** 每次請求的檔數上限。實測 60 檔可用，再多沒試過，保守用 50。 */
const BATCH = 50;

interface MisRow {
  c: string;
  n: string;
  /** 最近成交價。該瞬間沒成交時是 "-" */
  z: string;
  /** 最佳五檔委買，底線分隔 */
  b: string;
  a: string;
  o: string;
  h: string;
  l: string;
  /** 昨收 */
  y: string;
  /** 累積成交量（張） */
  v: string;
  t: string;
  d: string;
  ex: string;
}

export interface LiveQuote {
  stockId: string;
  name: string;
  /** 成交價；沒有成交時退回最佳委買，再退回昨收 */
  price: number | null;
  /** price 是怎麼來的，畫面上要標示清楚 */
  priceSource: 'trade' | 'bid' | 'prevClose';
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** 累積成交量（張） */
  volume: number | null;
  change: number | null;
  changePct: number | null;
  /** 報價時間 HH:MM:SS */
  time: string;
  /** 報價日期 YYYY-MM-DD */
  date: string;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "2475.0000_2470.0000_..." → 2475 */
function firstOf(v: string | undefined): number | null {
  return toNum(v?.split('_')[0]);
}

function parse(r: MisRow): LiveQuote {
  const traded = toNum(r.z);
  const bid = firstOf(r.b);
  const prevClose = toNum(r.y);

  // z 是「該瞬間有沒有成交」，冷門股與撮合空檔常常是 "-"，
  // 直接當成沒價格會讓半數個股空白，所以依序退回最佳委買、昨收。
  let price = traded;
  let priceSource: LiveQuote['priceSource'] = 'trade';
  if (price === null) {
    price = bid;
    priceSource = 'bid';
  }
  if (price === null) {
    price = prevClose;
    priceSource = 'prevClose';
  }

  const change = price !== null && prevClose !== null ? price - prevClose : null;

  return {
    stockId: r.c,
    name: r.n,
    price,
    priceSource,
    prevClose,
    open: toNum(r.o),
    high: toNum(r.h),
    low: toNum(r.l),
    volume: toNum(r.v),
    change,
    changePct: change !== null && prevClose ? (change / prevClose) * 100 : null,
    time: r.t ?? '',
    date: /^\d{8}$/.test(r.d ?? '') ? `${r.d.slice(0, 4)}-${r.d.slice(4, 6)}-${r.d.slice(6)}` : '',
  };
}

/** market 對應 MIS 的頻道前綴：上市 tse、上櫃與興櫃 otc */
function channel(stockId: string, market: string): string {
  return `${market === 'twse' ? 'tse' : 'otc'}_${stockId}.tw`;
}

export async function fetchLiveQuotes(
  stocks: { stockId: string; market: string }[],
): Promise<LiveQuote[]> {
  const out: LiveQuote[] = [];

  for (let i = 0; i < stocks.length; i += BATCH) {
    const chunk = stocks.slice(i, i + BATCH);
    const url = new URL(MIS_URL);
    url.searchParams.set('ex_ch', chunk.map((s) => channel(s.stockId, s.market)).join('|'));
    url.searchParams.set('json', '1');
    url.searchParams.set('delay', '0');
    // 少了 Referer 會被擋
    url.searchParams.set('_', String(Date.now()));

    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        referer: 'https://mis.twse.com.tw/stock/fibest.jsp',
        'user-agent': 'Mozilla/5.0',
      },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`即時報價取得失敗: HTTP ${res.status}`);

    const body = (await res.json()) as { rtcode?: string; rtmessage?: string; msgArray?: MisRow[] };
    if (body.rtcode !== '0000') {
      throw new Error(`即時報價回傳錯誤: ${body.rtcode} ${body.rtmessage ?? ''}`);
    }
    for (const r of body.msgArray ?? []) out.push(parse(r));
  }

  return out;
}
