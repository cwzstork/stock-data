/**
 * 逐檔歷史回補。
 *
 *   npm run backfill                        乾跑（預設）：只抓幾檔看資料對不對，不寫入
 *   npm run backfill -- --commit            實際寫入，自動挑還沒補完的資料集
 *   npm run backfill -- --commit --dataset=annual
 *   npm run backfill -- --commit '--stocks=2330,0056'
 *
 * 為什麼逐檔：
 *   FinMind 免費層擋掉「不帶 data_id 的全市場查詢」，
 *   但帶 data_id 時一次呼叫就拿到該檔十年份，所以逐檔其實很划算。
 *
 * 為什麼要能續跑：
 *   三千多檔、每小時 600 次的額度，一次跑不完。
 *   進度記在 backfill_log，沒有它的話「本來就沒資料的公司」會每次被重抓。
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  fetchDividends,
  fetchPerHistory,
  fetchPriceHistory,
  fetchStatements,
  fetchBalanceSheetFull,
  fetchMonthRevenue,
  type DividendRow,
  type StatementRow,
  type PerRow,
  type PriceRow,
} from '../src/lib/finmind';
import { appendDaily, finalizeYears, readParquetBaseUrl, readParquetDir } from '../src/lib/parquet';

try {
  process.loadEnvFile('.env');
} catch {
  // CI 由環境變數提供
}

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

/** 從哪一年開始補。算 10 年平均要再往前一點，多抓一年當緩衝 */
const START_DATE = flag('start') ?? '2015-01-01';

/**
 * 指定股票代號，逗號分隔。
 *
 * 在 PowerShell 一定要加引號：
 *     npm run backfill -- '--stocks=2330,0056,00878'      對
 *     npm run backfill -- --stocks=2330,0056,00878        錯
 * 不加引號時 PowerShell 會把逗號串當成陣列、把 0056 當數字，
 * 實際傳進來的會變成「2330,56,878」。這不會報錯，只會安靜地查錯股票，
 * 而台股 ETF 代號全靠前導零（0050 / 0056 / 00878）。
 */
const ONLY = flag('stocks')?.split(',').map((s) => s.trim()).filter(Boolean);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 工具 ──────────────────────────────────────────────────────────

/** 一批陣列攤成 text[] 交給 UNNEST，型別由 Postgres 轉，避免 JS number 破壞精度 */
function cols<T>(rows: T[], pick: ((r: T) => string | null)[]): (string | null)[][] {
  return pick.map((f) => rows.map(f));
}

const num = (v: number | null | undefined): string | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : String(v);

/** 平均。空陣列回 null，不要回 0——0 的意思完全不同 */
const avg = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

// ── 資料集：配息 ──────────────────────────────────────────────────

interface DivRow {
  stockId: string;
  exDate: string;
  cash: string;
  stockDiv: string;
  payDate: string | null;
  period: string | null;
}

/**
 * 一列原始紀錄 → 一次除息。
 * 沒有除息（權）日的是「已公告但尚未除息」，還不算真的配發過，納入會讓殖利率虛增。
 */
function normalizeDividend(stockId: string, r: DividendRow): DivRow | null {
  const exDate = r.CashExDividendTradingDate || r.StockExDividendTradingDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate ?? '')) return null;
  const cash = (r.CashEarningsDistribution ?? 0) + (r.CashStatutorySurplus ?? 0);
  const stockDiv = (r.StockEarningsDistribution ?? 0) + (r.StockStatutorySurplus ?? 0);
  if (cash <= 0 && stockDiv <= 0) return null;
  return {
    stockId,
    exDate,
    cash: cash.toFixed(6),
    stockDiv: stockDiv.toFixed(6),
    payDate: /^\d{4}-\d{2}-\d{2}$/.test(r.CashDividendPaymentDate) ? r.CashDividendPaymentDate : null,
    period: r.year || null,
  };
}

/**
 * 同一個除息日出現多列時的處理。
 *
 * 上游會有重複列：00878 的 2023-08-16 出現兩次，金額與發放日完全相同，
 * 只有 date 欄位不一樣。這種要去重，不能加總——加總會讓那次配息變成兩倍。
 * 金額不同理論上不該發生，真的遇到就取最後一筆並回報，不要安靜地選一個。
 */
function dedupe(rows: DivRow[]): { rows: DivRow[]; dropped: number; conflicts: string[] } {
  const byDate = new Map<string, DivRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.exDate);
    if (list) list.push(r);
    else byDate.set(r.exDate, [r]);
  }
  const out: DivRow[] = [];
  const conflicts: string[] = [];
  let dropped = 0;
  for (const [exDate, list] of byDate) {
    if (list.length > 1) {
      dropped += list.length - 1;
      if (new Set(list.map((r) => `${r.cash}|${r.stockDiv}`)).size > 1) {
        conflicts.push(exDate);
      }
    }
    out.push(list[list.length - 1]);
  }
  out.sort((a, b) => a.exDate.localeCompare(b.exDate));
  return { rows: out, dropped, conflicts };
}

async function runDividend(stockId: string) {
  const raw = await fetchDividends(stockId, START_DATE);
  const { rows, dropped, conflicts } = dedupe(
    raw.map((r) => normalizeDividend(stockId, r)).filter((r): r is DivRow => r !== null),
  );
  if (!COMMIT || rows.length === 0) return { rows: rows.length, dropped, conflicts, note: '' };

  const c = cols(rows, [
    (r) => r.stockId,
    (r) => r.exDate,
    (r) => r.cash,
    (r) => r.stockDiv,
    (r) => r.payDate,
    (r) => r.period,
  ]);
  await prisma.$executeRawUnsafe(
    `INSERT INTO stock_dividend (stock_id, ex_date, cash, stock_div, pay_date, period)
     SELECT id, ex::date, ca::numeric, sd::numeric, pd::date, p
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
            AS x(id, ex, ca, sd, pd, p)
     ON CONFLICT (stock_id, ex_date) DO UPDATE SET
       cash = EXCLUDED.cash, stock_div = EXCLUDED.stock_div,
       pay_date = EXCLUDED.pay_date, period = EXCLUDED.period`,
    ...c,
  );
  const last = rows[rows.length - 1];
  return {
    rows: rows.length,
    dropped,
    conflicts,
    note: `最近除息 ${last.exDate} 現金 ${Number(last.cash).toFixed(4)}`,
  };
}

// ── 資料集：年度彙總 ──────────────────────────────────────────────

interface AnnualRow {
  stockId: string;
  year: string;
  avgClose: string | null;
  high: string | null;
  low: string | null;
  lastClose: string | null;
  days: string;
  avgPer: string | null;
  minPer: string | null;
  avgPbr: string | null;
  minPbr: string | null;
  avgYield: string | null;
  maxYield: string | null;
}

/**
 * 日頻 → 年度彙總。
 *
 * 本益比／股價淨值比在虧損或無資料時，上游會給 0 或 null。
 * 0 不能當成「最便宜」——那是「沒有意義」，所以一律濾掉非正數，
 * 否則「近 N 年最低本益比」會全部變成 0。
 */
function aggregate(stockId: string, prices: PriceRow[], pers: PerRow[]): AnnualRow[] {
  const byYear = new Map<
    string,
    { close: number[]; high: number[]; low: number[]; last: { d: string; c: number } | null }
  >();
  for (const p of prices) {
    const y = p.date.slice(0, 4);
    const g = byYear.get(y) ?? { close: [], high: [], low: [], last: null };
    if (Number.isFinite(p.close) && p.close > 0) {
      g.close.push(p.close);
      if (!g.last || p.date > g.last.d) g.last = { d: p.date, c: p.close };
    }
    if (Number.isFinite(p.max) && p.max > 0) g.high.push(p.max);
    if (Number.isFinite(p.min) && p.min > 0) g.low.push(p.min);
    byYear.set(y, g);
  }

  const perByYear = new Map<string, { per: number[]; pbr: number[]; yld: number[] }>();
  for (const p of pers) {
    const y = p.date.slice(0, 4);
    const g = perByYear.get(y) ?? { per: [], pbr: [], yld: [] };
    if (p.PER != null && p.PER > 0) g.per.push(p.PER);
    if (p.PBR != null && p.PBR > 0) g.pbr.push(p.PBR);
    if (p.dividend_yield != null && p.dividend_yield > 0) g.yld.push(p.dividend_yield);
    perByYear.set(y, g);
  }

  const out: AnnualRow[] = [];
  for (const [year, g] of [...byYear].sort(([a], [b]) => a.localeCompare(b))) {
    if (g.close.length === 0) continue;
    const v = perByYear.get(year) ?? { per: [], pbr: [], yld: [] };
    out.push({
      stockId,
      year,
      avgClose: num(avg(g.close)),
      high: num(g.high.length ? Math.max(...g.high) : null),
      low: num(g.low.length ? Math.min(...g.low) : null),
      lastClose: num(g.last?.c ?? null),
      days: String(g.close.length),
      avgPer: num(avg(v.per)),
      minPer: num(v.per.length ? Math.min(...v.per) : null),
      avgPbr: num(avg(v.pbr)),
      minPbr: num(v.pbr.length ? Math.min(...v.pbr) : null),
      avgYield: num(avg(v.yld)),
      maxYield: num(v.yld.length ? Math.max(...v.yld) : null),
    });
  }
  return out;
}

// 沒設定 PARQUET_DIR 就是 null，整段外存會安靜跳過
const PARQUET_DIR = readParquetDir();
let parquetRows = 0;
let dailyRows = 0;

/**
 * 挑出要寫進 stock_daily 的日期：每月最後一個交易日 ＋ 最近 N 個交易日。
 *
 * 「每月最後一個交易日」不能用月底日期去猜——月底可能是假日，
 * 而且個股停牌、剛上市都會讓實際交易日缺漏。只能從實際有資料的日期裡挑。
 */
function pickDailyDates(prices: PriceRow[]): Set<string> {
  const sorted = [...prices].map((p) => p.date).sort();
  const picked = new Set<string>(sorted.slice(-DAILY_RECENT_DAYS));

  const lastOfMonth = new Map<string, string>();
  for (const d of sorted) lastOfMonth.set(d.slice(0, 7), d);
  for (const d of [...lastOfMonth.values()].sort().slice(-DAILY_MONTH_ENDS)) picked.add(d);

  return picked;
}

async function writeDailyRows(stockId: string, prices: PriceRow[], pers: PerRow[]) {
  const wanted = pickDailyDates(prices);
  const perByDate = new Map(pers.map((p) => [p.date, p]));

  const rows = prices.filter((p) => wanted.has(p.date));
  if (rows.length === 0) return 0;

  const c = cols(rows, [
    () => stockId,
    (r) => r.date,
    (r) => num(r.close),
    (r) => num(r.Trading_Volume),
    (r) => num(r.Trading_money),
    (r) => num(perByDate.get(r.date)?.dividend_yield ?? null),
    (r) => num(perByDate.get(r.date)?.PER ?? null),
    (r) => num(perByDate.get(r.date)?.PBR ?? null),
  ]);
  return prisma.$executeRawUnsafe(
    `INSERT INTO stock_daily (stock_id, trade_date, close, volume, turnover, dividend_yield, per, pbr)
     SELECT id, dt::date, cl::numeric, vol::bigint, tv::bigint, dy::numeric, pe::numeric, pb::numeric
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[])
            AS x(id, dt, cl, vol, tv, dy, pe, pb)
     ON CONFLICT (stock_id, trade_date) DO UPDATE SET
       close = EXCLUDED.close, volume = EXCLUDED.volume, turnover = EXCLUDED.turnover,
       dividend_yield = EXCLUDED.dividend_yield, per = EXCLUDED.per, pbr = EXCLUDED.pbr`,
    ...c,
  );
}

async function runAnnual(stockId: string) {
  const prices = await fetchPriceHistory(stockId, START_DATE);
  await sleep(CALL_GAP_MS);
  // ETF 與興櫃沒有評價資料，這支會回空陣列，不算錯誤
  const pers = await fetchPerHistory(stockId, START_DATE);

  const rows = aggregate(stockId, prices, pers);
  if (!COMMIT || rows.length === 0) return { rows: rows.length, dropped: 0, conflicts: [], note: '' };

  // Parquet 外存已經搬去獨立的「日頻 Parquet」資料集。
  // 原本是在這裡順手寫的（prices 本來就抓進來了，不用多打 API），
  // 但年度檔必須等整輪抓完才寫得出來，混在這裡會讓兩件事的生命週期糾纏。
  const daily = await writeDailyRows(stockId, prices, pers);
  dailyRows += daily;

  const c = cols(rows, [
    (r) => r.stockId,
    (r) => r.year,
    (r) => r.avgClose,
    (r) => r.high,
    (r) => r.low,
    (r) => r.lastClose,
    (r) => r.days,
    (r) => r.avgPer,
    (r) => r.minPer,
    (r) => r.avgPbr,
    (r) => r.minPbr,
    (r) => r.avgYield,
    (r) => r.maxYield,
  ]);
  await prisma.$executeRawUnsafe(
    `INSERT INTO stock_annual (stock_id, year, avg_close, high, low, last_close, days,
                               avg_per, min_per, avg_pbr, min_pbr, avg_yield, max_yield)
     SELECT id, y::int, ac::numeric, hi::numeric, lo::numeric, lc::numeric, dy::int,
            ap::numeric, mp::numeric, apb::numeric, mpb::numeric, ay::numeric, my::numeric
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[])
            AS x(id, y, ac, hi, lo, lc, dy, ap, mp, apb, mpb, ay, my)
     ON CONFLICT (stock_id, year) DO UPDATE SET
       avg_close = EXCLUDED.avg_close, high = EXCLUDED.high, low = EXCLUDED.low,
       last_close = EXCLUDED.last_close, days = EXCLUDED.days,
       avg_per = EXCLUDED.avg_per, min_per = EXCLUDED.min_per,
       avg_pbr = EXCLUDED.avg_pbr, min_pbr = EXCLUDED.min_pbr,
       avg_yield = EXCLUDED.avg_yield, max_yield = EXCLUDED.max_yield`,
    ...c,
  );
  const last = rows[rows.length - 1];
  return {
    rows: rows.length,
    dropped: 0,
    conflicts: [],
    note: `${rows[0].year}~${last.year} 均價 ${Number(last.avgClose).toFixed(2)}  日頻 ${daily} 列`,
  };
}

// ── 資料集：十年季報 ──────────────────────────────────────────────

/**
 * FinMind 的 type → 我們的欄位。
 *
 * EquityAttributableToOwnersOfParent 在兩支 API 裡意義完全不同
 * （損益表是「淨利歸屬母公司」，資產負債表是「母公司權益」），
 * 所以兩張對照表分開寫、不共用，避免哪天合併時把兩者搞混。
 */
/**
 * FinMind 的 type 對照。
 *
 * 一個概念在不同行業會有不同的 type 名稱，差一個字母就整欄抓不到，
 * 所以每個欄位都用「依序試」的別名清單，不是單一對應。
 */
const INCOME_ALIASES = {
  // 金控的 Revenue 是「淨收益」，實測 106,275,016,000
  // ＝利息淨收益 56,958,729,000 ＋利息以外淨收益 49,316,287,000，數字自洽。
  // 證券期貨業叫 Income（收益）。銀行沒有單一營收概念，會是 null。
  revenue: ['Revenue', 'Income'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncome'],
  // 銀行用 IncomeBeforeTaxFromContinuingOperations
  pretaxIncome: ['PreTaxIncome', 'IncomeBeforeTaxFromContinuingOperations'],
  // 金控與銀行是 IncomeAfterTax，少一個 s
  netIncome: ['IncomeAfterTaxes', 'IncomeAfterTax', 'IncomeFromContinuingOperations'],
  netIncomeParent: ['EquityAttributableToOwnersOfParent'],
  // 金融業的損益表完全沒有 EPS，那是上游就沒有，不是漏抓
  eps: ['EPS'],
} as const;

const BALANCE_ALIASES = {
  currentAssets: ['CurrentAssets'],
  currentLiabilities: ['CurrentLiabilities'],
  totalAssets: ['TotalAssets'],
  totalLiabilities: ['Liabilities'],
  totalEquity: ['Equity'],
  // 注意：EquityAttributableToOwnersOfParent 在損益表是「淨利歸屬母公司」、
  // 在資產負債表是「母公司權益」，兩者意義完全不同，所以兩張表分開對照。
  // 金融業多半沒有這一項，要用 權益總計 − 非控制權益 推回來。
  equityParent: ['EquityAttributableToOwnersOfParent'],
  // 富邦金這類有特別股的沒有 CapitalStock，只有 OrdinaryShare
  capitalStock: ['CapitalStock', 'OrdinaryShare'],
} as const;

interface QuarterRow {
  stockId: string;
  periodEnd: string;
  revenue: string | null;
  grossProfit: string | null;
  operatingIncome: string | null;
  pretaxIncome: string | null;
  netIncome: string | null;
  netIncomeParent: string | null;
  eps: string | null;
  currentAssets: string | null;
  currentLiabilities: string | null;
  totalAssets: string | null;
  totalLiabilities: string | null;
  totalEquity: string | null;
  equityParent: string | null;
  bookValuePerShare: string | null;
  capitalStock: string | null;
}

/** 一期的原始 type → 數值，之後再依別名清單挑出需要的 */
type RawPeriod = Map<string, number>;

function collect(rows: StatementRow[]): Map<string, RawPeriod> {
  const byDate = new Map<string, RawPeriod>();
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    // _per 結尾的是佔比欄位，不是金額
    if (r.type.endsWith('_per')) continue;
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    let m = byDate.get(r.date);
    if (!m) byDate.set(r.date, (m = new Map()));
    m.set(r.type, v);
  }
  return byDate;
}

/** 依序試別名，回第一個有值的。缺值回 null 而不是 0 —— 兩者意義完全不同 */
function pickNum(raw: RawPeriod | undefined, names: readonly string[]): number | null {
  if (!raw) return null;
  for (const n of names) {
    const v = raw.get(n);
    if (v !== undefined) return v;
  }
  return null;
}

const asText = (v: number | null) => (v === null ? null : String(v));

function buildQuarters(
  stockId: string,
  income: StatementRow[],
  balance: StatementRow[],
): QuarterRow[] {
  const inc = collect(income);
  const bal = collect(balance);
  const dates = [...new Set([...inc.keys(), ...bal.keys()])].sort();

  return dates.map((periodEnd) => {
    const i = inc.get(periodEnd);
    const b = bal.get(periodEnd);

    // 金融業多半沒有「歸屬母公司權益」，用 權益總計 − 非控制權益 推回來。
    // 實測富邦金 1,284,103,748,000 − 16,453,963,000 = 1,267,649,785,000，
    // 與證交所公告的母公司權益完全相同。
    let equityParent = pickNum(b, BALANCE_ALIASES.equityParent);
    if (equityParent === null) {
      const total = pickNum(b, BALANCE_ALIASES.totalEquity);
      const minority = pickNum(b, ['NoncontrollingInterests']);
      if (total !== null) equityParent = total - (minority ?? 0);
    }

    // 每股淨值的分母用「股本合計」，跟證交所公告的「每股參考淨值」同口徑。
    // 實測：統一證 29.99、台積電 248.05，與證交所完全相同。
    //
    // 少數有特別股的金控上游缺 CapitalStock，只能退回普通股股本，
    // 分母偏小會讓每股淨值偏高（富邦金 90.50 vs 官方 81.22）。
    // 這個偏差會連帶影響便宜價（淨值），金控股看那一欄要有警覺。
    const shareBase = pickNum(b, ['CapitalStock']) ?? pickNum(b, ['OrdinaryShare']);
    let bookValuePerShare: string | null = null;
    if (equityParent !== null && shareBase !== null && shareBase > 0) {
      // 台股絕大多數面額 10 元，股數 = 股本 ÷ 10
      bookValuePerShare = (equityParent / (shareBase / 10)).toFixed(2);
    }

    return {
      stockId,
      periodEnd,
      revenue: asText(pickNum(i, INCOME_ALIASES.revenue)),
      grossProfit: asText(pickNum(i, INCOME_ALIASES.grossProfit)),
      operatingIncome: asText(pickNum(i, INCOME_ALIASES.operatingIncome)),
      pretaxIncome: asText(pickNum(i, INCOME_ALIASES.pretaxIncome)),
      netIncome: asText(pickNum(i, INCOME_ALIASES.netIncome)),
      netIncomeParent: asText(pickNum(i, INCOME_ALIASES.netIncomeParent)),
      eps: asText(pickNum(i, INCOME_ALIASES.eps)),
      currentAssets: asText(pickNum(b, BALANCE_ALIASES.currentAssets)),
      currentLiabilities: asText(pickNum(b, BALANCE_ALIASES.currentLiabilities)),
      totalAssets: asText(pickNum(b, BALANCE_ALIASES.totalAssets)),
      totalLiabilities: asText(pickNum(b, BALANCE_ALIASES.totalLiabilities)),
      totalEquity: asText(pickNum(b, BALANCE_ALIASES.totalEquity)),
      equityParent: asText(equityParent),
      bookValuePerShare,
      capitalStock: asText(pickNum(b, BALANCE_ALIASES.capitalStock)),
    };
  });
}

async function runQuarterly(stockId: string) {
  const income = await fetchStatements(stockId, START_DATE);
  await sleep(CALL_GAP_MS);
  const balance = await fetchBalanceSheetFull(stockId, START_DATE);

  const rows = buildQuarters(stockId, income, balance);
  if (!COMMIT || rows.length === 0) return { rows: rows.length, dropped: 0, conflicts: [], note: '' };

  {
    // 一檔最多 42 期，不用分批
    const c = cols(rows, [
      (r) => r.stockId,
      (r) => r.periodEnd,
      (r) => r.revenue,
      (r) => r.grossProfit,
      (r) => r.operatingIncome,
      (r) => r.pretaxIncome,
      (r) => r.netIncome,
      (r) => r.netIncomeParent,
      (r) => r.eps,
      (r) => r.currentAssets,
      (r) => r.currentLiabilities,
      (r) => r.totalAssets,
      (r) => r.totalLiabilities,
      (r) => r.totalEquity,
      (r) => r.equityParent,
      (r) => r.bookValuePerShare,
      (r) => r.capitalStock,
    ]);
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_quarterly (
         stock_id, period_end, revenue, gross_profit, operating_income, pretax_income,
         net_income, net_income_parent, eps, current_assets, current_liabilities,
         total_assets, total_liabilities, total_equity, equity_parent,
         book_value_per_share, capital_stock)
       SELECT id, pe::date, rev::bigint, gp::bigint, oi::bigint, pti::bigint,
              ni::bigint, nip::bigint, eps::numeric, ca::bigint, cl::bigint,
              ta::bigint, tl::bigint, te::bigint, ep::bigint, bv::numeric, cs::bigint
         FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                     $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[],
                     $13::text[], $14::text[], $15::text[], $16::text[], $17::text[])
              AS x(id, pe, rev, gp, oi, pti, ni, nip, eps, ca, cl, ta, tl, te, ep, bv, cs)
       ON CONFLICT (stock_id, period_end) DO UPDATE SET
         revenue = EXCLUDED.revenue, gross_profit = EXCLUDED.gross_profit,
         operating_income = EXCLUDED.operating_income, pretax_income = EXCLUDED.pretax_income,
         net_income = EXCLUDED.net_income, net_income_parent = EXCLUDED.net_income_parent,
         eps = EXCLUDED.eps, current_assets = EXCLUDED.current_assets,
         current_liabilities = EXCLUDED.current_liabilities,
         total_assets = EXCLUDED.total_assets, total_liabilities = EXCLUDED.total_liabilities,
         total_equity = EXCLUDED.total_equity, equity_parent = EXCLUDED.equity_parent,
         book_value_per_share = EXCLUDED.book_value_per_share,
         capital_stock = EXCLUDED.capital_stock`,
      ...c,
    );
  }

  const last = rows[rows.length - 1];
  return {
    rows: rows.length,
    dropped: 0,
    conflicts: [],
    note: `${rows[0].periodEnd} ~ ${last.periodEnd}　最新單季EPS ${last.eps ?? '—'}`,
  };
}

// ── 資料集：月營收 ────────────────────────────────────────────────

async function runRevenue(stockId: string) {
  const raw = await fetchMonthRevenue(stockId, START_DATE);
  const rows = raw
    .filter((r) => r.revenue_year > 0 && r.revenue_month >= 1 && r.revenue_month <= 12)
    .map((r) => ({
      // FinMind 的 date 是公告日附近，不是所屬月份，要用 revenue_year/month 決定
      month: `${r.revenue_year}-${String(r.revenue_month).padStart(2, '0')}-01`,
      revenue: num(r.revenue),
    }))
    .filter((r) => r.revenue !== null);

  if (!COMMIT || rows.length === 0) return { rows: rows.length, dropped: 0, conflicts: [], note: '' };

  const c = cols(rows, [() => stockId, (r) => r.month, (r) => r.revenue]);
  await prisma.$executeRawUnsafe(
    `INSERT INTO stock_revenue (stock_id, month, revenue)
     SELECT id, m::date, rev::bigint
       FROM UNNEST($1::text[], $2::text[], $3::text[]) AS x(id, m, rev)
     ON CONFLICT (stock_id, month) DO UPDATE SET revenue = EXCLUDED.revenue`,
    ...c,
  );
  const last = rows[rows.length - 1];
  return {
    rows: rows.length,
    dropped: 0,
    conflicts: [],
    note: `${rows[0].month.slice(0, 7)} ~ ${last.month.slice(0, 7)}`,
  };
}

/**
 * 日頻 Parquet 外存。
 *
 * 只打一次 API（價格），把整段十年日頻累積到每年一個 NDJSON，
 * 整輪結束時由 finalizeYears 合併成年度 Parquet。
 *
 * 排在最後：它是冷資料，而篩選器要的欄位都來自前面幾個資料集。
 * 3,081 檔 × 6.4s ≈ 5.5 小時，會跨兩輪跑完——第二輪靠 stock_id 比對
 * 把第一輪的結果合併進來，不會重複也不會覆蓋掉。
 */
async function runParquet(stockId: string) {
  const prices = await fetchPriceHistory(stockId, START_DATE);
  if (!PARQUET_DIR) {
    return { rows: 0, dropped: 0, conflicts: [], note: '未設定 PARQUET_DIR，略過' };
  }
  if (!COMMIT || prices.length === 0) {
    return { rows: prices.length, dropped: 0, conflicts: [], note: '' };
  }
  const w = await appendDaily(PARQUET_DIR, prices);
  parquetRows += w.rows;
  return {
    rows: w.rows,
    dropped: 0,
    conflicts: [],
    note: `${prices[0].date} ~ ${prices[prices.length - 1].date}　${w.years} 個年度`,
  };
}

// ── 資料集登記 ────────────────────────────────────────────────────

interface Dataset {
  key: string;
  label: string;
  /** 每檔要打幾次 API，用來換算節流間隔 */
  calls: number;
  run: (stockId: string) => Promise<{ rows: number; dropped: number; conflicts: string[]; note: string }>;
}

const DATASETS: Dataset[] = [
  { key: 'dividend', label: '配息紀錄', calls: 1, run: runDividend },
  { key: 'annual', label: '年度彙總', calls: 2, run: runAnnual },
  { key: 'quarterly', label: '十年季報', calls: 2, run: runQuarterly },
  { key: 'revenue', label: '十年月營收', calls: 1, run: runRevenue },
  { key: 'parquet', label: '日頻 Parquet 外存', calls: 1, run: runParquet },
];

/** FinMind register 層的文件額度是 600 次/小時，留一點餘裕給每日同步 */
const CALLS_PER_HOUR = Number(flag('rate') ?? 560);

/**
 * 單次執行要跑多久。
 *
 * 排程每 6 小時一次、job 逾時設 5 小時，這裡抓 4.7 小時，
 * 讓腳本自己先跑完而不是被 GitHub 砍掉，log 才會有完整的結尾統計。
 * 一開始設計成「每小時一批」，但實測 GitHub 的排程根本沒有準時觸發——
 * workflow 設定完全正確卻連續三個小時一次都沒跑，官方文件也明說排程是
 * 盡力而為、高負載時會延遲甚至丟棄。
 * 與其依賴它每小時觸發，不如讓單次跑滿，少觸發幾次就少一次失敗機會。
 */
const RUN_HOURS = Number(flag('hours') ?? 4.7);
/** 同一檔內連續兩次呼叫之間的間隔 */
const CALL_GAP_MS = Math.round(3_600_000 / CALLS_PER_HOUR);

/** 已經補過的檔多久之後才重抓 */
const REFRESH_DAYS = Number(flag('refresh') ?? 30);

/**
 * 回補期間要一併寫進 stock_daily 的歷史日期。
 *
 * 十年日頻全放進資料庫要 690 萬列、超過 1 GB，撞爆 Neon 免費層 0.5 GB。
 * 但只留「每月最後一個交易日」的話，十年也才 120 期、約 122 MB，
 * 用一半的容量換到二十倍的時間跨度。再加上近三個月的每一天，
 * 就同時涵蓋「長期回顧」與「近期逐日比對」兩種用法。
 *
 * 完整的十年逐日仍然在 Parquet 裡，要精確到某一天再去查那邊。
 */
const DAILY_RECENT_DAYS = Number(flag('recentDays') ?? 61);
const DAILY_MONTH_ENDS = Number(flag('monthEnds') ?? 120);

async function pickTargets(ds: Dataset, limit: number) {
  if (ONLY?.length) {
    return prisma.$queryRawUnsafe<{ stock_id: string; stock_name: string }[]>(
      `SELECT stock_id, stock_name FROM stock WHERE stock_id = ANY($1::text[]) ORDER BY stock_id`,
      ONLY,
    );
  }
  return prisma.$queryRawUnsafe<{ stock_id: string; stock_name: string }[]>(
    `SELECT s.stock_id, s.stock_name
       FROM stock s
       LEFT JOIN backfill_log b ON b.stock_id = s.stock_id AND b.dataset = $1
      WHERE b.stock_id IS NULL OR b.synced_at < now() - ($2 || ' days')::interval
      ORDER BY b.synced_at NULLS FIRST, s.stock_id
      LIMIT $3`,
    ds.key,
    String(REFRESH_DAYS),
    limit,
  );
}

async function progress(key: string) {
  const [r] = await prisma.$queryRawUnsafe<{ total: number; done: number }[]>(
    `SELECT (SELECT count(*)::int FROM stock) AS total,
            (SELECT count(*)::int FROM backfill_log WHERE dataset = $1) AS done`,
    key,
  );
  return r;
}

/**
 * 跑一個資料集，直到它的待辦清空或時間用完。
 */
async function runDataset(ds: Dataset, deadline: number, t0: number): Promise<void> {
  const budgetMs = Math.max(0, deadline - Date.now());
  const itemGap = CALL_GAP_MS * ds.calls;
  const limit = Number(
    flag('limit') ?? (COMMIT ? Math.max(1, Math.floor(budgetMs / itemGap)) : 3),
  );

  console.log(`\n=== 回補「${ds.label}」 ${COMMIT ? '【實際寫入】' : '【乾跑 DRY RUN】'} ===`);
  const estHours = (limit * itemGap) / 3_600_000;
  console.log(
    `起始 ${START_DATE}　本次上限 ${limit} 檔　每檔 ${ds.calls} 次呼叫　` +
      `間隔 ${(itemGap / 1000).toFixed(1)}s　預估最多 ${estHours.toFixed(1)} 小時`,
  );
  const p0 = await progress(ds.key);
  console.log(`整體進度 ${p0.done} / ${p0.total}`);
  if (ds.key === 'annual') {
    console.log(`寫入資料庫的日期：每月最後交易日 ${DAILY_MONTH_ENDS} 期 ＋ 最近 ${DAILY_RECENT_DAYS} 個交易日`);
  }
  if (ds.key === 'parquet') {
    console.log(PARQUET_DIR ? `輸出到：${PARQUET_DIR}` : '未設定 PARQUET_DIR，這個資料集會空轉');
    const base = readParquetBaseUrl();
    console.log(base ? `與既有年度檔合併：${base}` : '沒設 PARQUET_BASE_URL，整包重建不合併');
  }
  console.log('');

  const targets = await pickTargets(ds, limit);
  if (targets.length === 0) {
    console.log('沒有待處理的股票。');
    return;
  }

  let ok = 0;
  let empty = 0;
  let failed = 0;
  let dropped = 0;
  // 這兩個是跨資料集累計的，先記下起點，收尾時報差額
  const daily0 = dailyRows;
  const rows0 = parquetRows;

  for (const [i, t] of targets.entries()) {
    // 時間到就停。剩下的留給下一輪——進度記在 backfill_log，不會重做。
    if (Date.now() >= deadline) {
      console.log(`  … 時間用完，這個資料集本輪處理到第 ${i} 檔`);
      break;
    }
    if (i > 0) await sleep(itemGap);
    try {
      const r = await ds.run(t.stock_id);
      dropped += r.dropped;
      if (r.conflicts.length) {
        console.warn(`      ! ${t.stock_id} 同一日期資料不一致: ${r.conflicts.join(', ')}`);
      }
      if (COMMIT) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO backfill_log (stock_id, dataset, synced_at, rows) VALUES ($1,$2,now(),$3)
           ON CONFLICT (stock_id, dataset) DO UPDATE SET synced_at = now(), rows = EXCLUDED.rows`,
          t.stock_id,
          ds.key,
          r.rows,
        );
      }
      if (r.rows === 0) empty += 1;
      else ok += 1;

      const pct = (((i + 1) / targets.length) * 100).toFixed(0);
      console.log(
        `  [${String(i + 1).padStart(4)}/${targets.length} ${pct.padStart(3)}%] ` +
          `${t.stock_id.padEnd(7)} ${String(t.stock_name).padEnd(12)} ${String(r.rows).padStart(4)} 列  ${r.note}`,
      );
    } catch (e) {
      failed += 1;
      // 失敗不記進度，下次會重試
      console.error(`  [${i + 1}/${targets.length}] ${t.stock_id} 失敗:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(
    `\n本次：有資料 ${ok}　無資料 ${empty}　失敗 ${failed}` + (dropped ? `　去除重複列 ${dropped}` : ''),
  );
  if (dailyRows > daily0) {
    console.log(`寫入 stock_daily：${(dailyRows - daily0).toLocaleString()} 列`);
  }
  if (ds.key === 'parquet' && COMMIT && PARQUET_DIR && parquetRows > rows0) {
    console.log(`
收斂成年度 Parquet（本輪累積 ${(parquetRows - rows0).toLocaleString()} 列）…`);
    const files = await finalizeYears(PARQUET_DIR, readParquetBaseUrl());
    let bytes = 0;
    for (const y of files) {
      bytes += y.bytes;
      console.log(
        `  ${y.year}  ${y.rows.toLocaleString().padStart(9)} 列  ` +
          `${(y.bytes / 1024 / 1024).toFixed(1).padStart(6)} MB  ` +
          `${y.merged ? '已與既有檔合併' : '只有本輪資料'}`,
      );
    }
    console.log(`合計 ${files.length} 個年度檔 / ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  }
  if (!COMMIT) console.log('（乾跑，沒有寫入也沒有記錄進度）');

  const p1 = await progress(ds.key);
  console.log(
    `整體進度 ${p1.done} / ${p1.total}${p1.done < p1.total ? `　還差 ${p1.total - p1.done} 檔` : '　已完成'}`,
  );
  console.log(`耗時 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分鐘`);
}

/**
 * 一輪之內把時間用完。
 *
 * 原本是「挑第一個沒補完的資料集，跑完就結束」，於是只要主檔多了幾檔新股票，
 * 配息就會從 3,081/3,083 變成「沒補完」，整輪就花十幾秒補那兩檔然後收工——
 * 一個六小時的排程窗只做了十幾秒的事，排在後面的季報永遠輪不到。
 *
 * 改成依序走完 DATASETS：目前這個清空了就接下一個，直到時間用完。
 */
async function main() {
  const t0 = Date.now();
  const deadline = t0 + RUN_HOURS * 3_600_000;

  const only = DATASETS.find((d) => d.key === flag('dataset'));
  const queue = only ? [only] : DATASETS;

  let didSomething = false;
  for (const ds of queue) {
    if (Date.now() >= deadline) {
      console.log("\n時間用完，其餘資料集留到下一輪。");
      break;
    }
    const p = await progress(ds.key);
    if (!only && p.done >= p.total) continue;
    didSomething = true;
    await runDataset(ds, deadline, t0);
  }
  if (!didSomething) console.log('所有資料集都補完了。');
}

main()
  .catch((e) => {
    console.error('\n[FAIL] 回補失敗:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
