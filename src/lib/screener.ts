import { prisma } from './prisma';

/**
 * 篩選條件。
 *
 * 條件全部放在 URL query string 裡，不存進資料庫：
 * 網址可以加書籤、可以分享，而且永遠是「重新跑一次最新資料」。
 * 存結果才會過期——今天存的清單，明天股價變了就不準。
 */
export interface Filters {
  /** 基準日 YYYY-MM-DD；null = 用資料庫裡最新的交易日 */
  date: string | null;
  /** twse / tpex / emerging；空陣列 = 不限 */
  markets: string[];
  industry: string | null;
  /** 股號或股名關鍵字 */
  q: string | null;
  yieldMin: number | null;
  yieldMax: number | null;
  perMin: number | null;
  perMax: number | null;
  pbrMin: number | null;
  pbrMax: number | null;
  closeMin: number | null;
  closeMax: number | null;
  /** 成交量下限，單位：張 */
  volMin: number | null;
  /** 股本下限／上限，單位：百萬元 */
  capMin: number | null;
  capMax: number | null;
  sort: SortKey;
  dir: 'asc' | 'desc';
  page: number;
  size: number;
}

export const MARKET_LABEL: Record<string, string> = {
  twse: '上市',
  tpex: '上櫃',
  emerging: '興櫃',
};

/** 允許排序的欄位。白名單是必要的——欄位名會直接拼進 SQL。 */
const SORT_COLUMNS = {
  stock_id: 's.stock_id',
  close: 'd.close',
  volume: 'd.volume',
  turnover: 'd.turnover',
  dividend_yield: 'd.dividend_yield',
  per: 'd.per',
  pbr: 'd.pbr',
  capital: 'cap.capital',
} as const;

export type SortKey = keyof typeof SORT_COLUMNS;

export const PAGE_SIZES = [25, 50, 100, 200] as const;

function toNumber(v: unknown): number | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (Array.isArray(v)) v = v[0];
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

export type RawParams = Record<string, string | string[] | undefined>;

export function parseFilters(params: RawParams): Filters {
  const markets = (Array.isArray(params.market) ? params.market : params.market ? [params.market] : [])
    .filter((m) => m in MARKET_LABEL);

  const sortRaw = toStr(params.sort);
  const sort: SortKey = sortRaw && sortRaw in SORT_COLUMNS ? (sortRaw as SortKey) : 'dividend_yield';

  const sizeRaw = toNumber(toStr(params.size));
  const size = PAGE_SIZES.includes(sizeRaw as (typeof PAGE_SIZES)[number]) ? sizeRaw! : 50;

  return {
    date: toStr(params.date),
    markets,
    industry: toStr(params.industry),
    q: toStr(params.q),
    yieldMin: toNumber(toStr(params.yieldMin)),
    yieldMax: toNumber(toStr(params.yieldMax)),
    perMin: toNumber(toStr(params.perMin)),
    perMax: toNumber(toStr(params.perMax)),
    pbrMin: toNumber(toStr(params.pbrMin)),
    pbrMax: toNumber(toStr(params.pbrMax)),
    closeMin: toNumber(toStr(params.closeMin)),
    closeMax: toNumber(toStr(params.closeMax)),
    volMin: toNumber(toStr(params.volMin)),
    capMin: toNumber(toStr(params.capMin)),
    capMax: toNumber(toStr(params.capMax)),
    sort,
    dir: toStr(params.dir) === 'asc' ? 'asc' : 'desc',
    page: Math.max(1, toNumber(toStr(params.page)) ?? 1),
    size,
  };
}

export interface ScreenerRow {
  stock_id: string;
  stock_name: string;
  market: string;
  industry_category: string | null;
  trade_date: string;
  close: string | null;
  volume: string | null;
  turnover: string | null;
  dividend_yield: string | null;
  per: string | null;
  pbr: string | null;
  capital: string | null;
}

/**
 * 股本的時間對位。
 *
 * 股本來自「公司基本資料」，它的日期是資料出表日，不是交易日；
 * 出表日往往比交易日還晚（例：2026-09-28 出表，對應 2026-09-24 的行情）。
 * 所以不能只寫 report_date <= trade_date，那樣最新一天會完全對不到。
 *
 * 規則：優先取交易日當天或之前最接近的一筆；真的沒有才取之後最接近的。
 * 實收資本額一年變動不到一兩次，這個近似在實務上不會失真。
 */
const CAPITAL_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT k.capital
      FROM stock_capital k
     WHERE k.stock_id = d.stock_id
     ORDER BY (k.report_date <= d.trade_date) DESC, abs(k.report_date - d.trade_date)
     LIMIT 1
  ) cap ON true`;

interface Where {
  sql: string;
  values: unknown[];
}

function buildWhere(f: Filters, tradeDate: string): Where {
  const values: unknown[] = [tradeDate];
  const parts = ['d.trade_date = $1::date'];
  /** clause 裡所有的 ? 都綁到同一個參數，所以 q 那種要比對兩個欄位的條件可以直接寫 */
  const add = (clause: string, value: unknown) => {
    values.push(value);
    parts.push(clause.replaceAll('?', `$${values.length}`));
  };

  if (f.markets.length) add('s.market = ANY(?)', f.markets);
  if (f.industry) add('s.industry_category = ?', f.industry);
  if (f.q) add('(s.stock_id ILIKE ? OR s.stock_name ILIKE ?)', `%${f.q}%`);

  if (f.yieldMin !== null) add('d.dividend_yield >= ?', f.yieldMin);
  if (f.yieldMax !== null) add('d.dividend_yield <= ?', f.yieldMax);
  if (f.perMin !== null) add('d.per >= ?', f.perMin);
  if (f.perMax !== null) add('d.per <= ?', f.perMax);
  if (f.pbrMin !== null) add('d.pbr >= ?', f.pbrMin);
  if (f.pbrMax !== null) add('d.pbr <= ?', f.pbrMax);
  if (f.closeMin !== null) add('d.close >= ?', f.closeMin);
  if (f.closeMax !== null) add('d.close <= ?', f.closeMax);
  // 畫面上的成交量單位是張，資料庫存的是股
  if (f.volMin !== null) add('d.volume >= ?', Math.round(f.volMin * 1000));
  // 畫面上的股本單位是百萬元，資料庫存的是元
  if (f.capMin !== null) add('cap.capital >= ?', Math.round(f.capMin * 1e6));
  if (f.capMax !== null) add('cap.capital <= ?', Math.round(f.capMax * 1e6));

  return { sql: parts.join('\n     AND '), values };
}

/** 資料庫裡有行情的交易日，新到舊 */
export async function getTradeDates(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ d: string }[]>(
    `SELECT to_char(trade_date, 'YYYY-MM-DD') AS d
       FROM stock_daily GROUP BY trade_date ORDER BY trade_date DESC LIMIT 400`,
  );
  return rows.map((r) => r.d);
}

export async function getIndustries(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ industry_category: string }[]>(
    `SELECT DISTINCT industry_category FROM stock
      WHERE industry_category IS NOT NULL ORDER BY industry_category`,
  );
  return rows.map((r) => r.industry_category);
}

const SELECT_COLS = `
  s.stock_id, s.stock_name, s.market, s.industry_category,
  to_char(d.trade_date, 'YYYY-MM-DD') AS trade_date,
  d.close::text          AS close,
  d.volume::text         AS volume,
  d.turnover::text       AS turnover,
  d.dividend_yield::text AS dividend_yield,
  d.per::text            AS per,
  d.pbr::text            AS pbr,
  cap.capital::text      AS capital`;

/**
 * 數值欄位一律 cast 成 text 再交給 JS 格式化。
 * 讓 Decimal / BigInt 在驅動層做隱式轉換，成交金額這種量級會有精度風險。
 */
function baseQuery(where: Where, f: Filters) {
  return `
    FROM stock_daily d
    JOIN stock s ON s.stock_id = d.stock_id
    ${CAPITAL_LATERAL}
   WHERE ${where.sql}
   ORDER BY ${SORT_COLUMNS[f.sort]} ${f.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, s.stock_id ASC`;
}

export interface ScreenerResult {
  rows: ScreenerRow[];
  total: number;
  tradeDate: string;
  page: number;
  pageCount: number;
}

export async function runScreener(f: Filters): Promise<ScreenerResult | null> {
  const dates = await getTradeDates();
  if (dates.length === 0) return null;
  const tradeDate = f.date && dates.includes(f.date) ? f.date : dates[0];

  const where = buildWhere(f, tradeDate);

  const countSql = `SELECT count(*)::int AS n
    FROM stock_daily d
    JOIN stock s ON s.stock_id = d.stock_id
    ${CAPITAL_LATERAL}
   WHERE ${where.sql}`;
  const [{ n: total }] = await prisma.$queryRawUnsafe<{ n: number }[]>(countSql, ...where.values);

  const pageCount = Math.max(1, Math.ceil(total / f.size));
  const page = Math.min(f.page, pageCount);

  const rows = await prisma.$queryRawUnsafe<ScreenerRow[]>(
    `SELECT ${SELECT_COLS} ${baseQuery(where, f)}
       LIMIT ${f.size} OFFSET ${(page - 1) * f.size}`,
    ...where.values,
  );

  return { rows, total, tradeDate, page, pageCount };
}

/** 匯出用：不分頁，一次拿全部（上限保護避免誤操作拉爆記憶體） */
export async function runScreenerForExport(f: Filters, limit = 10_000): Promise<ScreenerRow[]> {
  const dates = await getTradeDates();
  if (dates.length === 0) return [];
  const tradeDate = f.date && dates.includes(f.date) ? f.date : dates[0];
  const where = buildWhere(f, tradeDate);
  return prisma.$queryRawUnsafe<ScreenerRow[]>(
    `SELECT ${SELECT_COLS} ${baseQuery(where, f)} LIMIT ${limit}`,
    ...where.values,
  );
}
