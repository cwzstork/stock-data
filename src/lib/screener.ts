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
  // ── 以下來自配息紀錄 ──
  tyMin: number | null;
  tyMax: number | null;
  /** 近 5 年平均股利 ÷ 基準股價 的下限(%) */
  y5Min: number | null;
  /** 近 10 年平均股利 ÷ 基準股價 的下限(%) */
  y10Min: number | null;
  /** 連續配息年數下限 */
  streakMin: number | null;
  /** 流動比率下限(%) */
  crMin: number | null;
  /** ROA 年化下限(%) */
  roaMin: number | null;
  /** 董監持股下限(%) */
  dirMin: number | null;
  /** 董監設質上限(%) */
  pledgeMax: number | null;
  /** 股價相對便宜價的上限，例如 1 表示「股價 <= 便宜價」 */
  cheapRatioMax: number | null;
  /** 單季營收年增率下限(%) */
  revYoyMin: number | null;
  /** 近四季 ROE 下限(%) */
  roeTtmMin: number | null;
  /** 月營收年增下限(%) */
  revMYoyMin: number | null;
  /** 自算預估 EPS 下限 */
  estEpsMin: number | null;
  /** 5 年歷史平均殖利率下限(%) */
  hy5Min: number | null;
  /** 10 年歷史平均殖利率下限(%) */
  hy10Min: number | null;
  /** 近 5 年最低本益比上限 */
  minPer5Max: number | null;
  /** 年度 EPS 連續成長年數下限（3 / 5 / 10）*/
  epsGrowMin: number | null;
  /** ROE 3 / 5 / 10 年平均的下限(%) */
  roeAvg3Min: number | null;
  roeAvg5Min: number | null;
  roeAvg10Min: number | null;
  /** 近四季自由現金流下限，單位：百萬元 */
  fcfMin: number | null;
  /** 盈餘含金量下限(%)：近四季營業現金流 ÷ 稅後淨利 */
  cfNiMin: number | null;
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
/**
 * 股本：優先用季報的歷史值。
 *
 * `stock_capital` 來自「公司基本資料」，只有最新那一兩期——所以切到 2018 的
 * 基準日時，股本欄位給的其實是今天的股本，是 look-ahead。
 * `stock_quarterly.capital_stock` 有逐季歷史（實測 89,517 / 90,231 列、2,445 檔），
 * 對位規則又是嚴格 period_end <= trade_date，拿到的就是當期的真實股本。
 * 實測鴻海 2015 年 1,479 億 → 2018 減資到 1,386 億 → 2026 年 1,407 億，確實會變。
 *
 * 口徑上有一點差異要知道：季報是「普通股股本」，公司基本資料是「股本合計」
 * （含特別股）。一般公司兩者差 0.02% 以內，但有發特別股的金控差一成——
 * 實測富邦金 1,400 億 vs 1,560 億（−10.25%）、國泰金 −9.46%。
 * 這裡採普通股股本，因為它才有歷史、也才是每股指標的分母。
 *
 * 季報沒有的（ETF、興櫃）退回用 stock_capital。
 */
const CAPITAL_EXPR = 'COALESCE(q.capital_stock, cap.capital)';

const RATIO = {
  // 累計：同年度各季加總，跟證交所公告的累計數同口徑
  gross_margin: 'CASE WHEN ytd.revenue > 0 THEN ytd.gross_profit * 100.0 / ytd.revenue END',
  op_margin: 'CASE WHEN ytd.revenue > 0 THEN ytd.operating_income * 100.0 / ytd.revenue END',
  net_margin: 'CASE WHEN ytd.revenue > 0 THEN ytd.net_income_parent * 100.0 / ytd.revenue END',
  // 單季：只看最新那一季，看得出短期轉折
  gross_margin_q: 'CASE WHEN q.revenue > 0 THEN q.gross_profit * 100.0 / q.revenue END',
  op_margin_q: 'CASE WHEN q.revenue > 0 THEN q.operating_income * 100.0 / q.revenue END',
  net_margin_q: 'CASE WHEN q.revenue > 0 THEN q.net_income_parent * 100.0 / q.revenue END',
  // 單季年增率。去年同期為負或零時算不出有意義的成長率，一律留空
  rev_yoy: 'CASE WHEN yoy.revenue > 0 THEN (q.revenue - yoy.revenue) * 100.0 / yoy.revenue END',
  op_yoy:
    'CASE WHEN yoy.operating_income > 0 THEN (q.operating_income - yoy.operating_income) * 100.0 / yoy.operating_income END',
  ni_yoy:
    'CASE WHEN yoy.net_income_parent > 0 THEN (q.net_income_parent - yoy.net_income_parent) * 100.0 / yoy.net_income_parent END',
  // 近四季 EPS。本益比、ROE 用它比用累計年化準確
  eps_ttm: 'CASE WHEN ttm.quarters = 4 THEN ttm.eps END',
  roe_ttm: `CASE WHEN q.equity_parent > 0 AND ttm.quarters = 4
              THEN ttm.net_income_parent * 100.0 / q.equity_parent END`,
  roa_ttm: `CASE WHEN q.total_assets > 0 AND ttm.quarters = 4
              THEN ttm.net_income_parent * 100.0 / q.total_assets END`,
  debt_ratio: 'CASE WHEN q.total_assets > 0 THEN q.total_liabilities * 100.0 / q.total_assets END',
  // 用「近 N 年平均現金股利 ÷ 基準日收盤價」。
  // 嚴格定義應該是「每年股利 ÷ 該年均價再平均」，那需要歷史股價（Phase 3-2）。
  // 現在這個算的是「用今天的價格買進，領過去 N 年的平均股利會有多少報酬」。
  yield5: 'CASE WHEN d.close > 0 THEN dy.avg5 * 100.0 / d.close END',
  yield10: 'CASE WHEN d.close > 0 THEN dy.avg10 * 100.0 / d.close END',
  // 自己算的年化殖利率。ETF 交易所不公告，除息後也沒有更新延遲
  ttm_yield: 'CASE WHEN d.close > 0 THEN dv.ttm_cash * 100.0 / d.close END',
  // 流動比率。銀行、金控、保險的資產負債表沒有流動／非流動之分，會是空的
  current_ratio:
    'CASE WHEN q.current_liabilities > 0 THEN q.current_assets * 100.0 / q.current_liabilities END',
  // ROA 跟 ROE 一樣要年化：財報是累計數，Q2 只有半年淨利
  roa: `CASE WHEN q.total_assets > 0
          THEN ytd.net_income_parent * 100.0 / q.total_assets
               * (4.0 / EXTRACT(QUARTER FROM q.period_end))
        END`,
  // 三種便宜價，各自的假設不同，所以三欄都留讓你自己判斷
  //   股利法   近5年平均股利 ÷ 5%（等於 ×20）——存股角度
  //   本益比法 年化EPS × 近5年最低本益比——獲利角度
  //   淨值法   每股淨值 × 近5年最低股價淨值比——資產角度
  cheap_div: 'dy.avg5 * 20',
  cheap_per: `CASE WHEN ttm.quarters = 4 AND ttm.eps IS NOT NULL AND an.min_per5 IS NOT NULL
                THEN ttm.eps * an.min_per5 END`,
  cheap_pbr: 'q.book_value_per_share * an.min_pbr5',
  // 自算預估 EPS＝預估全年營收 × 淨利率 ÷ 股數
  est_eps: `CASE WHEN cap.issued_shares > 0 AND ttm.quarters = 4 AND ttm.revenue > 0
                  AND rev.ytd_ly > 0 AND rev.full_ly > 0 AND rev.months BETWEEN 1 AND 12
              THEN (rev.ytd + (rev.full_ly - rev.ytd_ly) * (rev.ytd::numeric / rev.ytd_ly))
                   * (ttm.net_income_parent::numeric / ttm.revenue)
                   / cap.issued_shares
            END`,
  est_eps_low: `CASE WHEN cap.issued_shares > 0 AND ml.low_margin IS NOT NULL
                      AND rev.ytd_ly > 0 AND rev.full_ly > 0 AND rev.months BETWEEN 1 AND 12
                  THEN (rev.ytd + (rev.full_ly - rev.ytd_ly))
                       * ml.low_margin
                       / cap.issued_shares
                END`,
  // 內部人持股比例。分母是已發行普通股數
  director_pct:
    'CASE WHEN cap.issued_shares > 0 THEN ins.director_shares * 100.0 / cap.issued_shares END',
  manager_pct:
    'CASE WHEN cap.issued_shares > 0 THEN ins.manager_shares * 100.0 / cap.issued_shares END',
  major_pct:
    'CASE WHEN cap.issued_shares > 0 THEN ins.major_shares * 100.0 / cap.issued_shares END',
  // 設質比例的分母是董監自己的持股，不是總股數
  pledge_pct:
    'CASE WHEN ins.director_shares > 0 THEN ins.director_pledged * 100.0 / ins.director_shares END',
  // 月營收年增。分母為零或負數時算不出有意義的成長率，留空
  rev_m_yoy:
    'CASE WHEN rev.last_rev_ly > 0 THEN (rev.last_rev - rev.last_rev_ly) * 100.0 / rev.last_rev_ly END',
  rev_ytd_yoy: 'CASE WHEN rev.ytd_ly > 0 THEN (rev.ytd - rev.ytd_ly) * 100.0 / rev.ytd_ly END',
  // 預估全年營收＝已公布累計 ＋ 剩餘月份（去年同期 × 今年累計成長倍數）
  est_revenue: `CASE WHEN rev.ytd_ly > 0 AND rev.full_ly > 0 AND rev.months BETWEEN 1 AND 12
                  THEN rev.ytd + (rev.full_ly - rev.ytd_ly) * (rev.ytd::numeric / rev.ytd_ly)
                END`,
  // 保守版：剩餘月份假設零成長，直接用去年同期
  est_revenue_low: `CASE WHEN rev.full_ly > 0 AND rev.ytd_ly > 0 AND rev.months BETWEEN 1 AND 12
                      THEN rev.ytd + (rev.full_ly - rev.ytd_ly)
                    END`,
  // ── 年度值（最新一個四季齊全的年度）──
  gross_margin_y: 'CASE WHEN af.revenue > 0 THEN af.gross_profit * 100.0 / af.revenue END',
  op_margin_y: 'CASE WHEN af.revenue > 0 THEN af.op_income * 100.0 / af.revenue END',
  net_margin_y: 'CASE WHEN af.revenue > 0 THEN af.net_parent * 100.0 / af.revenue END',
  // 不足 N 年就留空，不要拿 3 年的平均去充當 10 年
  roe_avg3: 'CASE WHEN af.roe3_n >= 3 THEN af.roe3 END',
  roe_avg5: 'CASE WHEN af.roe5_n >= 5 THEN af.roe5 END',
  roe_avg10: 'CASE WHEN af.roe10_n >= 10 THEN af.roe10 END',
  // ── 現金流量（近四季）──
  // 自由現金流＝營業活動現金流 ＋ 資本支出（資本支出本來就是負值）
  fcf_ttm: `CASE WHEN ttm.cf_quarters = 4
              THEN ttm.cf_operating + COALESCE(ttm.capex, 0) END`,
  cf_op_ttm: 'CASE WHEN ttm.cf_quarters = 4 THEN ttm.cf_operating END',
  // 盈餘含金量：營業現金流 ÷ 稅後淨利。長期低於 1 代表賺到的是帳面數字
  cf_to_ni: `CASE WHEN ttm.cf_quarters = 4 AND ttm.net_income_parent > 0
               THEN ttm.cf_operating * 100.0 / ttm.net_income_parent END`,
  roe: `CASE WHEN q.equity_parent > 0
          THEN ytd.net_income_parent * 100.0 / q.equity_parent
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
  capital: CAPITAL_EXPR,
  gross_margin: RATIO.gross_margin,
  op_margin: RATIO.op_margin,
  net_margin: RATIO.net_margin,
  debt_ratio: RATIO.debt_ratio,
  roe: RATIO.roe,
  eps: 'q.eps',
  bvps: 'q.book_value_per_share',
  ttm_yield: 'CASE WHEN d.close > 0 THEN dv.ttm_cash * 100.0 / d.close END',
  ttm_cash: 'dv.ttm_cash',
  yield5: 'CASE WHEN d.close > 0 THEN dy.avg5 * 100.0 / d.close END',
  yield10: 'CASE WHEN d.close > 0 THEN dy.avg10 * 100.0 / d.close END',
  streak: 'dy.streak',
  current_ratio: RATIO.current_ratio,
  roa: RATIO.roa,
  cheap_div: RATIO.cheap_div,
  cheap_per: RATIO.cheap_per,
  cheap_pbr: RATIO.cheap_pbr,
  director_pct: RATIO.director_pct,
  manager_pct: RATIO.manager_pct,
  major_pct: RATIO.major_pct,
  pledge_pct: RATIO.pledge_pct,
  hy5_min: 'an.hy5_min',
  avg_div5: 'dy.avg5',
  gross_margin_q: RATIO.gross_margin_q,
  op_margin_q: RATIO.op_margin_q,
  net_margin_q: RATIO.net_margin_q,
  rev_yoy: RATIO.rev_yoy,
  op_yoy: RATIO.op_yoy,
  ni_yoy: RATIO.ni_yoy,
  eps_ttm: RATIO.eps_ttm,
  roe_ttm: RATIO.roe_ttm,
  roa_ttm: RATIO.roa_ttm,
  rev_m_yoy: RATIO.rev_m_yoy,
  rev_ytd_yoy: RATIO.rev_ytd_yoy,
  est_eps: RATIO.est_eps,
  est_eps_low: RATIO.est_eps_low,
  hy5: 'an.hy5',
  hy10: 'an.hy10',
  min_per5: 'an.min_per5',
  eps_grow: 'eg.streak',
  eps_year: 'eg.last_eps',
  gross_margin_y: RATIO.gross_margin_y,
  op_margin_y: RATIO.op_margin_y,
  net_margin_y: RATIO.net_margin_y,
  roe_y: 'af.roe',
  roe_avg3: RATIO.roe_avg3,
  roe_avg5: RATIO.roe_avg5,
  roe_avg10: RATIO.roe_avg10,
  cf_op_ttm: RATIO.cf_op_ttm,
  fcf_ttm: RATIO.fcf_ttm,
  capex_ttm: 'ttm.capex',
  cf_to_ni: RATIO.cf_to_ni,
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
    tyMin: toNumber(toStr(params.tyMin)),
    tyMax: toNumber(toStr(params.tyMax)),
    y5Min: toNumber(toStr(params.y5Min)),
    y10Min: toNumber(toStr(params.y10Min)),
    streakMin: toNumber(toStr(params.streakMin)),
    crMin: toNumber(toStr(params.crMin)),
    roaMin: toNumber(toStr(params.roaMin)),
    dirMin: toNumber(toStr(params.dirMin)),
    pledgeMax: toNumber(toStr(params.pledgeMax)),
    cheapRatioMax: toNumber(toStr(params.cheapRatioMax)),
    revYoyMin: toNumber(toStr(params.revYoyMin)),
    roeTtmMin: toNumber(toStr(params.roeTtmMin)),
    revMYoyMin: toNumber(toStr(params.revMYoyMin)),
    estEpsMin: toNumber(toStr(params.estEpsMin)),
    hy5Min: toNumber(toStr(params.hy5Min)),
    hy10Min: toNumber(toStr(params.hy10Min)),
    minPer5Max: toNumber(toStr(params.minPer5Max)),
    epsGrowMin: toNumber(toStr(params.epsGrowMin)),
    roeAvg3Min: toNumber(toStr(params.roeAvg3Min)),
    roeAvg5Min: toNumber(toStr(params.roeAvg5Min)),
    roeAvg10Min: toNumber(toStr(params.roeAvg10Min)),
    fcfMin: toNumber(toStr(params.fcfMin)),
    cfNiMin: toNumber(toStr(params.cfNiMin)),
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
  ttm_yield: string | null;
  ttm_cash: string | null;
  ttm_count: string | null;
  yield5: string | null;
  yield10: string | null;
  streak: string | null;
  hy5: string | null;
  hy10: string | null;
  min_per5: string | null;
  low5: string | null;
  hy5_min: string | null;
  avg_div5: string | null;
  current_ratio: string | null;
  roa: string | null;
  cheap_div: string | null;
  cheap_per: string | null;
  cheap_pbr: string | null;
  director_pct: string | null;
  manager_pct: string | null;
  major_pct: string | null;
  pledge_pct: string | null;
  gross_margin_q: string | null;
  op_margin_q: string | null;
  net_margin_q: string | null;
  rev_yoy: string | null;
  op_yoy: string | null;
  ni_yoy: string | null;
  eps_ttm: string | null;
  roe_ttm: string | null;
  roa_ttm: string | null;
  quarters_ttm: string | null;
  rev_month: string | null;
  rev_months_done: string | null;
  rev_m_yoy: string | null;
  rev_ytd_yoy: string | null;
  est_eps: string | null;
  est_eps_low: string | null;
  /** 年度 EPS 連續成長年數 */
  eps_grow: string | null;
  /** 最新一個「四季齊全」的年度，例如 2025 */
  eps_year_last: string | null;
  /** 該年度的 EPS（四季加總） */
  eps_year: string | null;
  /** 前一年度的 EPS，讓成長幅度看得出來 */
  eps_year_prev: string | null;
  // ── 年度財報值（最新一個四季齊全的年度）──
  gross_margin_y: string | null;
  op_margin_y: string | null;
  net_margin_y: string | null;
  roe_y: string | null;
  roe_avg3: string | null;
  roe_avg5: string | null;
  roe_avg10: string | null;
  // ── 現金流量（近四季，單位：元，畫面上再換算百萬）──
  cf_op_ttm: string | null;
  fcf_ttm: string | null;
  capex_ttm: string | null;
  /** 盈餘含金量 % */
  cf_to_ni: string | null;
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
    SELECT k.capital, k.issued_shares
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
  ) q ON true
  -- 累計＝同年度各季加總。資料庫存的是單季，累計不落地、查詢時現算。
  LEFT JOIN LATERAL (
    SELECT sum(revenue) AS revenue, sum(gross_profit) AS gross_profit,
           sum(operating_income) AS operating_income, sum(net_income_parent) AS net_income_parent,
           sum(eps) AS eps, count(*) AS quarters,
           sum(cf_operating) AS cf_operating, sum(capex) AS capex
      FROM stock_quarterly yy
     WHERE yy.stock_id = d.stock_id
       AND yy.period_end <= d.trade_date
       AND extract(year from yy.period_end) = extract(year from q.period_end)
  ) ytd ON true
  -- 近四季。ROE 與本益比用它才對——累計數年化是近似，旺淡季不均的公司會失真。
  LEFT JOIN LATERAL (
    SELECT sum(revenue) AS revenue, sum(gross_profit) AS gross_profit,
           sum(operating_income) AS operating_income, sum(net_income_parent) AS net_income_parent,
           sum(eps) AS eps, count(*) AS quarters,
           sum(cf_operating) AS cf_operating, sum(capex) AS capex,
           count(cf_operating) AS cf_quarters
      FROM (
        SELECT * FROM stock_quarterly tt
         WHERE tt.stock_id = d.stock_id AND tt.period_end <= d.trade_date
         ORDER BY tt.period_end DESC LIMIT 4
      ) z
  ) ttm ON true
  -- 去年同期，算成長率用。期別相減剛好對上（2026-06-30 → 2025-06-30）
  LEFT JOIN LATERAL (
    SELECT * FROM stock_quarterly pp
     WHERE pp.stock_id = d.stock_id
       AND pp.period_end = (q.period_end - interval '1 year')::date
  ) yoy ON true`;

/**
 * 配息彙總。
 *
 * 為什麼不直接用 stock_daily.dividend_yield：
 *   交易所的 BWIBBU 報表不含 ETF（384 檔一筆都沒有），
 *   而且除息後股利基數有更新延遲（台積電 2026-09-16 除息 7 元，
 *   到 09-24 的公告殖利率仍未計入）。自己從逐筆紀錄算就沒這兩個問題。
 *
 * 「近 N 年」一律只算**完整年度**（去年往回數 N 年），不含當年。
 * 把只過了一半的當年度混進平均，會讓下半年配息的公司被嚴重低估。
 */
const DIVIDEND_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT sum(cash)  AS ttm_cash,
           count(*)   AS ttm_count
      FROM stock_dividend v
     WHERE v.stock_id = d.stock_id
       AND v.ex_date <= d.trade_date
       AND v.ex_date >  d.trade_date - interval '1 year'
  ) dv ON true
  LEFT JOIN LATERAL (
    SELECT avg(yr_cash) FILTER (WHERE yr > yr_base - 5)  AS avg5,
           avg(yr_cash) FILTER (WHERE yr > yr_base - 10) AS avg10,
           count(*)     FILTER (WHERE yr > yr_base - 10) AS paid_years,
           -- 連續配息年數：年份由新到舊排，idx 是名次。
           -- 沒斷的話「基準年 − 該年」會等於名次；一有缺年，差值就永遠大於名次，
           -- 之後再也不會相等，所以計數自然在斷點停住。
           count(*)     FILTER (WHERE yr_base - yr = idx) AS streak
      FROM (
        SELECT yr, yr_cash, yr_base,
               row_number() OVER (ORDER BY yr DESC) - 1 AS idx
          FROM (
            SELECT extract(year from v.ex_date)::int            AS yr,
                   sum(v.cash)                                  AS yr_cash,
                   extract(year from d.trade_date)::int - 1     AS yr_base
              FROM stock_dividend v
             WHERE v.stock_id = d.stock_id
               AND v.ex_date <= d.trade_date
               AND extract(year from v.ex_date)::int <= extract(year from d.trade_date)::int - 1
             GROUP BY 1, 3
            HAVING sum(v.cash) > 0
          ) g
      ) years
     GROUP BY yr_base
  ) dy ON true`;

/**
 * 年度彙總衍生值。
 *
 * 歷史殖利率＝當年配發的現金股利 ÷ 當年均價，再把各年平均起來。
 * 這才是嚴格定義的歷史殖利率——跟「平均股利 ÷ 今天的價格」是兩件事：
 *   前者問「過去這幾年買這檔的人平均領到多少報酬」
 *   後者問「用今天的價格買進，領過去的平均股利會有多少報酬」
 * 兩個都有用，所以畫面上兩欄都留。
 *
 * 那一年沒配息就是 0%，不能只平均有配的年份——只算有配的會高估。
 */
const ANNUAL_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT avg(hist_yield) FILTER (WHERE year > yr_base - 5)  AS hy5,
           avg(hist_yield) FILTER (WHERE year > yr_base - 10) AS hy10,
           min(hist_yield) FILTER (WHERE year > yr_base - 5)  AS hy5_min,
           min(min_per)    FILTER (WHERE year > yr_base - 5)  AS min_per5,
           min(min_pbr)    FILTER (WHERE year > yr_base - 5)  AS min_pbr5,
           min(low)        FILTER (WHERE year > yr_base - 5)  AS low5
      FROM (
        SELECT a.year, a.min_per, a.min_pbr, a.low,
               extract(year from d.trade_date)::int - 1 AS yr_base,
               CASE WHEN a.avg_close > 0
                    THEN coalesce(dd.cash, 0) * 100.0 / a.avg_close END AS hist_yield
          FROM stock_annual a
          LEFT JOIN LATERAL (
            SELECT sum(v.cash) AS cash
              FROM stock_dividend v
             WHERE v.stock_id = a.stock_id
               AND extract(year from v.ex_date)::int = a.year
          ) dd ON true
         WHERE a.stock_id = d.stock_id
           AND a.year <= extract(year from d.trade_date)::int - 1
      ) t
  ) an ON true`;

/**
 * 年度 EPS 連續成長年數。
 *
 * 資料庫存的是單季 EPS，年度 EPS＝該年四季加總，不落地、查詢時現算。
 * 只採「四季齊全且四季都有 EPS」的年度——少一季就會把該年低估，
 * 而低估的那年會假裝成「衰退」，把後面真正的連續紀錄硬生生切斷。
 *
 * 算法：年份由新到舊排，idx 是名次（最新年 = 0）。
 * 每年標記「有沒有比前一年成長」，streak 就是「第一個沒成長的名次」
 * ——也就是從最新年往回數連續成長了幾次。
 * 最舊那年沒有前一年可比，coalesce 成 false，所以 min(idx) 一定找得到值。
 *
 * 判定用嚴格大於，持平不算成長（實測統一證 2024、2025 都是 3.00，判 0）。
 * 年份不連續也不算（yr = 前一年 + 1），否則中間缺一年會被誤當成長。
 *
 * 這是純數值比較：EPS 從 -5 到 -3 也算成長一年。
 * 要排除虧損公司，另外加「EPS(近四季) >= 0」之類的條件。
 */
const EPS_GROWTH_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT min(idx) FILTER (WHERE NOT grew)::int AS streak,
           max(yr)  FILTER (WHERE idx = 0)       AS last_year,
           max(eps) FILTER (WHERE idx = 0)       AS last_eps,
           max(eps) FILTER (WHERE idx = 1)       AS prev_eps,
           count(*)::int                         AS years
      FROM (
        SELECT yr, eps,
               (row_number() OVER (ORDER BY yr DESC) - 1)::int AS idx,
               coalesce(eps > lag(eps) OVER (ORDER BY yr)
                        AND yr = lag(yr) OVER (ORDER BY yr) + 1, false) AS grew
          FROM (
            SELECT extract(year from e.period_end)::int AS yr, sum(e.eps) AS eps
              FROM stock_quarterly e
             WHERE e.stock_id = d.stock_id
               AND e.period_end <= d.trade_date
             GROUP BY 1
            HAVING count(*) = 4 AND count(e.eps) = 4
          ) a
      ) b
  ) eg ON true`;

/**
 * 年度財報值與 ROE 多年平均。
 *
 * 年度值＝該年四季加總（跟 EPS 連續成長同一個原則），只採四季齊全的年度——
 * 少一季會把該年低估，而低估的那年會把多年平均一起拖低。
 *
 * ROE 的分母用「該年 Q4 的母公司權益」（期末權益）。
 * 嚴格一點會用期初期末平均，但那要再拉前一年的 Q4，而且遇到第一年就沒有期初值；
 * 期末權益是多數台股看盤軟體的口徑，對得起來比較重要。
 *
 * 多年平均是「先算每年的 ROE 再平均」，不是「總淨利 ÷ 總權益」——
 * 後者會被權益大的年份主導，失去「這家公司每年穩不穩」的意義。
 *
 * rn 是年份由新到舊的名次，所以 rn <= 5 就是最近 5 個完整年度。
 * 不足 N 年的公司該欄留 null（不會拿 3 年的平均去充當 10 年）。
 */
const ANNUAL_FIN_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT max(yr)                                  AS last_year,
           max(revenue)      FILTER (WHERE rn = 1)  AS revenue,
           max(gross_profit) FILTER (WHERE rn = 1)  AS gross_profit,
           max(op_income)    FILTER (WHERE rn = 1)  AS op_income,
           max(net_parent)   FILTER (WHERE rn = 1)  AS net_parent,
           max(roe)          FILTER (WHERE rn = 1)  AS roe,
           avg(roe)          FILTER (WHERE rn <= 3) AS roe3,
           avg(roe)          FILTER (WHERE rn <= 5) AS roe5,
           avg(roe)          FILTER (WHERE rn <= 10) AS roe10,
           count(roe) FILTER (WHERE rn <= 3)::int   AS roe3_n,
           count(roe) FILTER (WHERE rn <= 5)::int   AS roe5_n,
           count(roe) FILTER (WHERE rn <= 10)::int  AS roe10_n
      FROM (
        SELECT yr, revenue, gross_profit, op_income, net_parent,
               CASE WHEN equity_end > 0 THEN net_parent * 100.0 / equity_end END AS roe,
               row_number() OVER (ORDER BY yr DESC) AS rn
          FROM (
            SELECT extract(year from a.period_end)::int AS yr,
                   sum(a.revenue)           AS revenue,
                   sum(a.gross_profit)      AS gross_profit,
                   sum(a.operating_income)  AS op_income,
                   sum(a.net_income_parent) AS net_parent,
                   max(a.equity_parent) FILTER (
                     WHERE extract(month from a.period_end) = 12) AS equity_end
              FROM stock_quarterly a
             WHERE a.stock_id = d.stock_id AND a.period_end <= d.trade_date
             GROUP BY 1
            HAVING count(*) = 4
          ) y
      ) z
  ) af ON true`;

/**
 * 內部人持股。取交易日之前最新公告的那個月。
 *
 * 比例的分母用「已發行普通股數」，不是股本除以 10——
 * 面額 10 元的公司兩者剛好相等，但非 10 元面額或有特別股的就會差。
 */
const INSIDER_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT *
      FROM stock_insider ii
     WHERE ii.stock_id = d.stock_id AND ii.period_end <= d.trade_date
     ORDER BY ii.period_end DESC
     LIMIT 1
  ) ins ON true`;

/**
 * 月營收彙總與自算預估 EPS。
 *
 * 法人預估 EPS 沒有免費來源（那是券商研究報告的產出，各財經網站是向資料商
 * 買來的）。但月營收是官方每月公告的免費資料，用它自己推估反而有兩個好處：
 * 算式公開可檢驗，而且月營收有十年歷史，這個推估法準不準是可以回測的。
 *
 * 推估方式：
 *   已公布月份用實際值，剩餘月份用「去年同期 × 今年累計成長率」補完，
 *   再乘上淨利率、除以股數。
 *
 *   基準：成長率用今年累計年增率，淨利率用近四季
 *   保守：假設剩餘月份零成長（就等於去年同期），淨利率取近八季單季最低
 *
 * 全年 12 個月都公布時，剩餘月份為 0，預估值自動收斂成實際值。
 */
const REVENUE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT rr.month
      FROM stock_revenue rr
     WHERE rr.stock_id = d.stock_id AND rr.month <= d.trade_date
     ORDER BY rr.month DESC
     LIMIT 1
  ) rvm ON true
  LEFT JOIN LATERAL (
    SELECT
      sum(r.revenue) FILTER (WHERE extract(year from r.month) = extract(year from rvm.month))
        AS ytd,
      count(*) FILTER (WHERE extract(year from r.month) = extract(year from rvm.month))
        AS months,
      sum(r.revenue) FILTER (WHERE extract(year from r.month) = extract(year from rvm.month) - 1
                               AND extract(month from r.month) <= extract(month from rvm.month))
        AS ytd_ly,
      sum(r.revenue) FILTER (WHERE extract(year from r.month) = extract(year from rvm.month) - 1)
        AS full_ly,
      max(r.revenue) FILTER (WHERE r.month = rvm.month) AS last_rev,
      max(r.revenue) FILTER (WHERE r.month = (rvm.month - interval '1 year')::date)
        AS last_rev_ly
      FROM stock_revenue r
     WHERE r.stock_id = d.stock_id AND r.month <= d.trade_date
  ) rev ON true
  -- 近八季裡最差的那一季淨利率，當作保守情境的獲利能力
  LEFT JOIN LATERAL (
    SELECT min(CASE WHEN z.revenue > 0 THEN z.net_income_parent * 1.0 / z.revenue END) AS low_margin
      FROM (
        SELECT * FROM stock_quarterly q8
         WHERE q8.stock_id = d.stock_id AND q8.period_end <= d.trade_date
         ORDER BY q8.period_end DESC LIMIT 8
      ) z
  ) ml ON true`;

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
  if (f.capMin !== null) add(`${CAPITAL_EXPR} >= ?`, Math.round(f.capMin * 1e6));
  if (f.capMax !== null) add(`${CAPITAL_EXPR} <= ?`, Math.round(f.capMax * 1e6));

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

  // 配息衍生條件
  if (f.tyMin !== null) add(`(${RATIO.ttm_yield}) >= ?`, f.tyMin);
  if (f.tyMax !== null) add(`(${RATIO.ttm_yield}) <= ?`, f.tyMax);
  if (f.y5Min !== null) add(`(${RATIO.yield5}) >= ?`, f.y5Min);
  if (f.y10Min !== null) add(`(${RATIO.yield10}) >= ?`, f.y10Min);
  if (f.streakMin !== null) add('dy.streak >= ?', f.streakMin);
  if (f.hy5Min !== null) add('an.hy5 >= ?', f.hy5Min);
  if (f.hy10Min !== null) add('an.hy10 >= ?', f.hy10Min);
  if (f.minPer5Max !== null) add('an.min_per5 <= ?', f.minPer5Max);
  // 連續成長 N 年需要 N+1 個完整年度才判斷得出來。資料不足時 eg.streak 是 NULL，
  // 比較結果也是 NULL、不會通過——正是要的行為：判斷不出來的不要混進結果。
  if (f.epsGrowMin !== null) add('eg.streak >= ?', f.epsGrowMin);
  // 年數不足的公司 RATIO 會回 NULL，比較結果也是 NULL、不會通過——
  // 正是要的行為：判斷不出來的不要混進結果。
  if (f.roeAvg3Min !== null) add(`(${RATIO.roe_avg3}) >= ?`, f.roeAvg3Min);
  if (f.roeAvg5Min !== null) add(`(${RATIO.roe_avg5}) >= ?`, f.roeAvg5Min);
  if (f.roeAvg10Min !== null) add(`(${RATIO.roe_avg10}) >= ?`, f.roeAvg10Min);
  // 畫面上的單位是百萬元，資料庫存的是元
  if (f.fcfMin !== null) add(`(${RATIO.fcf_ttm}) >= ?`, Math.round(f.fcfMin * 1e6));
  if (f.cfNiMin !== null) add(`(${RATIO.cf_to_ni}) >= ?`, f.cfNiMin);
  if (f.crMin !== null) add(`(${RATIO.current_ratio}) >= ?`, f.crMin);
  if (f.roaMin !== null) add(`(${RATIO.roa}) >= ?`, f.roaMin);
  if (f.dirMin !== null) add(`(${RATIO.director_pct}) >= ?`, f.dirMin);
  if (f.pledgeMax !== null) add(`(${RATIO.pledge_pct}) <= ?`, f.pledgeMax);
  if (f.revYoyMin !== null) add(`(${RATIO.rev_yoy}) >= ?`, f.revYoyMin);
  if (f.roeTtmMin !== null) add(`(${RATIO.roe_ttm}) >= ?`, f.roeTtmMin);
  if (f.revMYoyMin !== null) add(`(${RATIO.rev_m_yoy}) >= ?`, f.revMYoyMin);
  if (f.estEpsMin !== null) add(`(${RATIO.est_eps}) >= ?`, f.estEpsMin);
  // 三種便宜價取最寬鬆的一個當門檻：只要對其中一種來說夠便宜就算數。
  // 用最嚴格的會幾乎篩不到東西，三種假設本來就不會同時成立。
  if (f.cheapRatioMax !== null) {
    add(
      `d.close <= ? * GREATEST(
         COALESCE(${RATIO.cheap_div}, 0),
         COALESCE(${RATIO.cheap_per}, 0),
         COALESCE(${RATIO.cheap_pbr}, 0))
       AND GREATEST(
         COALESCE(${RATIO.cheap_div}, 0),
         COALESCE(${RATIO.cheap_per}, 0),
         COALESCE(${RATIO.cheap_pbr}, 0)) > 0`,
      f.cheapRatioMax,
    );
  }

  return { sql: parts.join('\n     AND '), values };
}

/**
 * 可以當基準日的交易日，新到舊。
 *
 * 只列有「上市」資料的日子。三個市場的 open API 更新時間不一致：
 * 興櫃常常先更新，上市與上櫃的日報表要到收盤後一兩個小時才齊。
 * 若不過濾，剛收盤那段時間資料庫裡會出現一個只有興櫃 360 筆的日期，
 * 而它是最新的、會被當成預設基準日——畫面上就變成查台積電查不到東西。
 *
 * 條件是「有上市資料，而且其中有本益比」。
 * 只看有沒有價格還不夠——歷史回補是先寫收盤價、評價資料另一支 API 提供，
 * 收盤當天評價通常還沒發布，於是最新那天會出現「有收盤沒殖利率沒本益比」，
 * 它又是最新的、被當成預設基準日，畫面上那三欄就整排空白。
 *
 * 還要再加一道覆蓋度門檻：至少要有最佳日期的四分之一檔數。
 * 回補是逐檔進行的，而「最近 61 個交易日」對冷門股來說是它自己的
 * 最後 61 個有成交日，跨的日曆區間可能長達數年，於是會生出大量
 * 只有兩三檔資料的日期。實測 1,075 個日期不到 10 檔，全部是這種。
 * 選到那種日期畫面上只會跑出三檔，看起來像壞掉。
 *
 * 用相對門檻而不是固定值，是因為回補期間總檔數一直在變，
 * 固定值訂多少都會在某個階段失準。
 */
export interface TradeDate {
  date: string;
  /** 這一天有資料的股票數。回補未完成時歷史日期會明顯偏少，標出來才不會誤判 */
  count: number;
}

export async function getTradeDates(): Promise<TradeDate[]> {
  const rows = await prisma.$queryRawUnsafe<{ d: string; n: number }[]>(
    `WITH cov AS (
       SELECT d.trade_date, count(*)::int AS n
         FROM stock_daily d
         JOIN stock s ON s.stock_id = d.stock_id
        WHERE s.market = 'twse' AND d.per IS NOT NULL
        GROUP BY d.trade_date
     )
     SELECT to_char(c.trade_date, 'YYYY-MM-DD') AS d,
            (SELECT count(*)::int FROM stock_daily x WHERE x.trade_date = c.trade_date) AS n
       FROM cov c
      WHERE c.n >= 0.25 * (SELECT max(n) FROM cov)
      ORDER BY c.trade_date DESC
      LIMIT 400`,
  );
  return rows.map((r) => ({ date: r.d, count: r.n }));
}

export interface PeriodInfo {
  /** 全市場最新一期財報的期別 */
  quarterEnd: string | null;
  /** 第幾季，1~4 */
  quarter: number | null;
  /** 股本資料的公告日 */
  capitalDate: string | null;
  /** 內部人持股資料的所屬月份 */
  insiderDate: string | null;
  /** 最新已公布月營收的月份 YYYY-MM */
  revenueMonth: string | null;
  /** 最新一個「四季齊全」的年度，EPS(年) 那幾欄的標題用它 */
  epsYear: number | null;
}

/**
 * 各項資料的實際期別，用來在畫面上把「累計」「當期」講成具體區間。
 *
 * 「累計」的長度隨季別變動（Q1 是 3 個月、Q2 是 6 個月…），
 * 「當期」對不同欄位又是不同日期（財報期末、股本公告日、內部人公告月），
 * 光寫「累計」「當期」使用者無從得知到底涵蓋多久。
 */
export async function getPeriodInfo(tradeDate: string): Promise<PeriodInfo> {
  const [r] = await prisma.$queryRawUnsafe<
    {
      q: string | null;
      cap: string | null;
      ins: string | null;
      rev: string | null;
      eps_year: string | null;
    }[]
  >(
    `SELECT (SELECT to_char(max(period_end), 'YYYY-MM-DD') FROM stock_quarterly
              WHERE period_end <= $1::date) AS q,
            (SELECT to_char(max(report_date), 'YYYY-MM-DD') FROM stock_capital
              WHERE report_date <= $1::date + 30) AS cap,
            (SELECT to_char(max(period_end), 'YYYY-MM-DD') FROM stock_insider
              WHERE period_end <= $1::date) AS ins,
            (SELECT to_char(max(month), 'YYYY-MM') FROM stock_revenue
              WHERE month <= $1::date) AS rev,
            -- 年度 EPS 要四季齊全才算得出來，所以最新完整年度不是「今年」
            -- 也不一定是「去年」——取真的有四季資料的最大年份。
            (SELECT max(yr)::text FROM (
               -- 要按「股票 × 年度」分組，不能只按年度：
               -- 只按年度的話 2025 在全市場有數千列，count(*) = 4 永遠不成立，
               -- 整欄標題會安靜退回成「最新完整年」而不報錯。
               SELECT stock_id, extract(year from period_end)::int AS yr
                 FROM stock_quarterly
                WHERE period_end <= $1::date AND eps IS NOT NULL
                GROUP BY 1, 2 HAVING count(*) = 4
             ) t) AS eps_year`,
    tradeDate,
  );
  const quarterEnd = r?.q ?? null;
  return {
    quarterEnd,
    quarter: quarterEnd ? Math.ceil(Number(quarterEnd.slice(5, 7)) / 3) : null,
    capitalDate: r?.cap ?? null,
    insiderDate: r?.ins ?? null,
    revenueMonth: r?.rev ?? null,
    epsYear: r?.eps_year ? Number(r.eps_year) : null,
  };
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
  ${CAPITAL_EXPR}::text      AS capital,
  to_char(q.period_end, 'YYYY-MM-DD')          AS period_end,
  round((${RATIO.gross_margin})::numeric, 2)::text AS gross_margin,
  round((${RATIO.op_margin})::numeric, 2)::text    AS op_margin,
  round((${RATIO.net_margin})::numeric, 2)::text   AS net_margin,
  round((${RATIO.debt_ratio})::numeric, 2)::text   AS debt_ratio,
  round((${RATIO.roe})::numeric, 2)::text          AS roe,
  q.eps::text                                  AS eps,
  q.book_value_per_share::text                 AS bvps,
  round((${RATIO.ttm_yield})::numeric, 2)::text AS ttm_yield,
  round(dv.ttm_cash, 4)::text                  AS ttm_cash,
  dv.ttm_count::text                           AS ttm_count,
  round((${RATIO.yield5})::numeric, 2)::text   AS yield5,
  round((${RATIO.yield10})::numeric, 2)::text  AS yield10,
  dy.streak::text                              AS streak,
  round(an.hy5, 2)::text                       AS hy5,
  round(an.hy10, 2)::text                      AS hy10,
  an.min_per5::text                            AS min_per5,
  an.low5::text                                AS low5,
  round(an.hy5_min, 2)::text                   AS hy5_min,
  round(dy.avg5, 4)::text                      AS avg_div5,
  round((${RATIO.current_ratio})::numeric, 2)::text AS current_ratio,
  round((${RATIO.roa})::numeric, 2)::text      AS roa,
  round((${RATIO.cheap_div})::numeric, 2)::text     AS cheap_div,
  round((${RATIO.cheap_per})::numeric, 2)::text     AS cheap_per,
  round((${RATIO.cheap_pbr})::numeric, 2)::text     AS cheap_pbr,
  round((${RATIO.director_pct})::numeric, 2)::text  AS director_pct,
  round((${RATIO.manager_pct})::numeric, 2)::text   AS manager_pct,
  round((${RATIO.major_pct})::numeric, 2)::text     AS major_pct,
  round((${RATIO.pledge_pct})::numeric, 2)::text    AS pledge_pct,
  round((${RATIO.gross_margin_q})::numeric, 2)::text AS gross_margin_q,
  round((${RATIO.op_margin_q})::numeric, 2)::text    AS op_margin_q,
  round((${RATIO.net_margin_q})::numeric, 2)::text   AS net_margin_q,
  round((${RATIO.rev_yoy})::numeric, 2)::text        AS rev_yoy,
  round((${RATIO.op_yoy})::numeric, 2)::text         AS op_yoy,
  round((${RATIO.ni_yoy})::numeric, 2)::text         AS ni_yoy,
  round((${RATIO.eps_ttm})::numeric, 2)::text        AS eps_ttm,
  round((${RATIO.roe_ttm})::numeric, 2)::text        AS roe_ttm,
  round((${RATIO.roa_ttm})::numeric, 2)::text        AS roa_ttm,
  ttm.quarters::text                                 AS quarters_ttm,
  to_char(rvm.month, 'YYYY-MM')                      AS rev_month,
  rev.months::text                                   AS rev_months_done,
  round((${RATIO.rev_m_yoy})::numeric, 2)::text      AS rev_m_yoy,
  round((${RATIO.rev_ytd_yoy})::numeric, 2)::text    AS rev_ytd_yoy,
  round((${RATIO.est_eps})::numeric, 2)::text        AS est_eps,
  round((${RATIO.est_eps_low})::numeric, 2)::text    AS est_eps_low,
  eg.streak::text                                    AS eps_grow,
  eg.last_year::text                                 AS eps_year_last,
  round(eg.last_eps, 2)::text                        AS eps_year,
  round(eg.prev_eps, 2)::text                        AS eps_year_prev,
  round((${RATIO.gross_margin_y})::numeric, 2)::text AS gross_margin_y,
  round((${RATIO.op_margin_y})::numeric, 2)::text    AS op_margin_y,
  round((${RATIO.net_margin_y})::numeric, 2)::text   AS net_margin_y,
  round(af.roe, 2)::text                             AS roe_y,
  round((${RATIO.roe_avg3})::numeric, 2)::text       AS roe_avg3,
  round((${RATIO.roe_avg5})::numeric, 2)::text       AS roe_avg5,
  round((${RATIO.roe_avg10})::numeric, 2)::text      AS roe_avg10,
  (${RATIO.cf_op_ttm})::text                         AS cf_op_ttm,
  (${RATIO.fcf_ttm})::text                           AS fcf_ttm,
  (CASE WHEN ttm.cf_quarters = 4 THEN ttm.capex END)::text AS capex_ttm,
  round((${RATIO.cf_to_ni})::numeric, 2)::text       AS cf_to_ni`;

/**
 * 數值欄位一律 cast 成 text 再交給 JS 格式化。
 * 讓 Decimal / BigInt 在驅動層做隱式轉換，成交金額這種量級會有精度風險。
 */
const FROM_CLAUSE = `
    FROM stock_daily d
    JOIN stock s ON s.stock_id = d.stock_id
    ${CAPITAL_LATERAL}
    ${QUARTERLY_LATERAL}
    ${DIVIDEND_LATERAL}
    ${ANNUAL_LATERAL}
    ${INSIDER_LATERAL}
    ${REVENUE_LATERAL}
    ${EPS_GROWTH_LATERAL}
    ${ANNUAL_FIN_LATERAL}`;

function baseQuery(where: Where, f: Filters) {
  return `${FROM_CLAUSE}
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
export async function runScreener(f: Filters, dates: TradeDate[]): Promise<ScreenerResult | null> {
  if (dates.length === 0) return null;
  const known = dates.map((d) => d.date);
  const tradeDate = f.date && known.includes(f.date) ? f.date : known[0];

  const where = buildWhere(f, tradeDate);

  // 跟清單共用同一份 FROM。各寫一份的話，新增 LATERAL 只改一邊
  // 會讓筆數與清單對不起來，而條件若引用了新的別名還會直接報錯。
  const countSql = `SELECT count(*)::int AS n ${FROM_CLAUSE}
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
  dates: TradeDate[],
  limit = 10_000,
): Promise<ScreenerRow[]> {
  if (dates.length === 0) return [];
  const known = dates.map((d) => d.date);
  const tradeDate = f.date && known.includes(f.date) ? f.date : known[0];
  const where = buildWhere(f, tradeDate);
  return prisma.$queryRawUnsafe<ScreenerRow[]>(
    `SELECT ${SELECT_COLS} ${baseQuery(where, f)} LIMIT ${limit}`,
    ...where.values,
  );
}
