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
  // ── 以下來自季頻財報 ──
  gmMin: number | null;
  gmMax: number | null;
  omMin: number | null;
  omMax: number | null;
  nmMin: number | null;
  nmMax: number | null;
  roeMin: number | null;
  roeMax: number | null;
  epsMin: number | null;
  epsMax: number | null;
  /** 負債比上限(%) */
  debtMax: number | null;
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

/**
 * 財報衍生比率。SELECT 和 WHERE 共用同一份定義，兩邊各寫一次遲早會飄掉。
 *
 * ROE 做了年化：財報是累計數，Q2 的淨利只有半年，直接除權益會低估一半。
 * 乘以 4/季別換算成年度基準，才能跟「ROE > 15%」這種條件對得上。
 * 這是近似——旺淡季不均的公司會失真，等十年歷史補完會改用近四季。
 */
const RATIO = {
  gross_margin: 'CASE WHEN q.revenue > 0 THEN q.gross_profit * 100.0 / q.revenue END',
  op_margin: 'CASE WHEN q.revenue > 0 THEN q.operating_income * 100.0 / q.revenue END',
  net_margin: 'CASE WHEN q.revenue > 0 THEN q.net_income_parent * 100.0 / q.revenue END',
  debt_ratio: 'CASE WHEN q.total_assets > 0 THEN q.total_liabilities * 100.0 / q.total_assets END',
  roe: `CASE WHEN q.equity_parent > 0
          THEN q.net_income_parent * 100.0 / q.equity_parent
               * (4.0 / EXTRACT(QUARTER FROM q.period_end))
        END`,
} as const;

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
  gross_margin: RATIO.gross_margin,
  op_margin: RATIO.op_margin,
  net_margin: RATIO.net_margin,
  debt_ratio: RATIO.debt_ratio,
  roe: RATIO.roe,
  eps: 'q.eps',
  bvps: 'q.book_value_per_share',
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
    gmMin: toNumber(toStr(params.gmMin)),
    gmMax: toNumber(toStr(params.gmMax)),
    omMin: toNumber(toStr(params.omMin)),
    omMax: toNumber(toStr(params.omMax)),
    nmMin: toNumber(toStr(params.nmMin)),
    nmMax: toNumber(toStr(params.nmMax)),
    roeMin: toNumber(toStr(params.roeMin)),
    roeMax: toNumber(toStr(params.roeMax)),
    epsMin: toNumber(toStr(params.epsMin)),
    epsMax: toNumber(toStr(params.epsMax)),
    debtMax: toNumber(toStr(params.debtMax)),
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
  /** 財報期別，null = 這檔沒有財報（ETF、興櫃等） */
  period_end: string | null;
  gross_margin: string | null;
  op_margin: string | null;
  net_margin: string | null;
  debt_ratio: string | null;
  roe: string | null;
  eps: string | null;
  bvps: string | null;
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

/**
 * 財報的時間對位，規則跟股本刻意不同。
 *
 * 股本可以往後找最接近的一筆，因為它只是「現況」；
 * 財報不行——用交易日之後才公告的財報去篩，是看未來資料，
 * 篩出來的結果在當下根本不可能知道。所以這裡嚴格只取 period_end <= 交易日。
 *
 * （嚴格說財報是季底後約 45 天才公告，這個近似仍然偏樂觀，
 *   但對「看當下基本面」的用途夠用；真要回測才需要用公告日對位。）
 */
const QUARTERLY_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT *
      FROM stock_quarterly qq
     WHERE qq.stock_id = d.stock_id AND qq.period_end <= d.trade_date
     ORDER BY qq.period_end DESC
     LIMIT 1
  ) q ON true`;

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

  // 財報衍生條件。用跟 SELECT 同一份 RATIO 定義，兩邊各寫一次遲早會飄掉。
  if (f.gmMin !== null) add(`(${RATIO.gross_margin}) >= ?`, f.gmMin);
  if (f.gmMax !== null) add(`(${RATIO.gross_margin}) <= ?`, f.gmMax);
  if (f.omMin !== null) add(`(${RATIO.op_margin}) >= ?`, f.omMin);
  if (f.omMax !== null) add(`(${RATIO.op_margin}) <= ?`, f.omMax);
  if (f.nmMin !== null) add(`(${RATIO.net_margin}) >= ?`, f.nmMin);
  if (f.nmMax !== null) add(`(${RATIO.net_margin}) <= ?`, f.nmMax);
  if (f.roeMin !== null) add(`(${RATIO.roe}) >= ?`, f.roeMin);
  if (f.roeMax !== null) add(`(${RATIO.roe}) <= ?`, f.roeMax);
  if (f.debtMax !== null) add(`(${RATIO.debt_ratio}) <= ?`, f.debtMax);
  if (f.epsMin !== null) add('q.eps >= ?', f.epsMin);
  if (f.epsMax !== null) add('q.eps <= ?', f.epsMax);

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
  cap.capital::text      AS capital,
  to_char(q.period_end, 'YYYY-MM-DD')          AS period_end,
  round((${RATIO.gross_margin})::numeric, 2)::text AS gross_margin,
  round((${RATIO.op_margin})::numeric, 2)::text    AS op_margin,
  round((${RATIO.net_margin})::numeric, 2)::text   AS net_margin,
  round((${RATIO.debt_ratio})::numeric, 2)::text   AS debt_ratio,
  round((${RATIO.roe})::numeric, 2)::text          AS roe,
  q.eps::text                                  AS eps,
  q.book_value_per_share::text                 AS bvps`;

/**
 * 數值欄位一律 cast 成 text 再交給 JS 格式化。
 * 讓 Decimal / BigInt 在驅動層做隱式轉換，成交金額這種量級會有精度風險。
 */
function baseQuery(where: Where, f: Filters) {
  return `
    FROM stock_daily d
    JOIN stock s ON s.stock_id = d.stock_id
    ${CAPITAL_LATERAL}
    ${QUARTERLY_LATERAL}
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

/**
 * dates 由呼叫端傳進來，不在這裡自己查。
 * 頁面本來就要拿交易日清單來畫下拉選單，函式內再查一次等於每次開頁多繞新加坡一趟。
 */
export async function runScreener(f: Filters, dates: string[]): Promise<ScreenerResult | null> {
  if (dates.length === 0) return null;
  const tradeDate = f.date && dates.includes(f.date) ? f.date : dates[0];

  const where = buildWhere(f, tradeDate);

  const countSql = `SELECT count(*)::int AS n
    FROM stock_daily d
    JOIN stock s ON s.stock_id = d.stock_id
    ${CAPITAL_LATERAL}
    ${QUARTERLY_LATERAL}
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
export async function runScreenerForExport(
  f: Filters,
  dates: string[],
  limit = 10_000,
): Promise<ScreenerRow[]> {
  if (dates.length === 0) return [];
  const tradeDate = f.date && dates.includes(f.date) ? f.date : dates[0];
  const where = buildWhere(f, tradeDate);
  return prisma.$queryRawUnsafe<ScreenerRow[]>(
    `SELECT ${SELECT_COLS} ${baseQuery(where, f)} LIMIT ${limit}`,
    ...where.values,
  );
}
