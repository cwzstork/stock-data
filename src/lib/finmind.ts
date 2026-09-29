/**
 * FinMind API v4 客戶端。
 *
 * 實測結論（2026-09-28，register 免費層）：
 *   - 不帶 data_id 的「全市場單日查詢」會被擋：
 *       HTTP 400 "Your level is register. Please update your user level."
 *     受影響：TaiwanStockPrice / TaiwanStockPER / TaiwanStockBalanceSheet
 *   - 帶 data_id 的「個股查詢」正常。
 *   - TaiwanStockInfo（無日期參數）正常，一次回 4,327 筆。
 *
 * 所以日頻全市場資料改用證交所 / 櫃買中心官方 open API（見 src/lib/twse.ts），
 * FinMind 留給「個股歷史回補」與「財報」這種必須逐檔抓的場景。
 */

import { fetchJson } from './http';

const BASE_URL = 'https://api.finmindtrade.com/api/v4/data';

export class FinMindError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly dataset: string,
  ) {
    super(message);
    this.name = 'FinMindError';
  }
}

type Params = Record<string, string | undefined>;

interface FinMindResponse<T> {
  msg?: string;
  status?: number;
  data?: T[];
}

/** 免費層有每小時請求上限，撞到就退避重試 */
async function request<T>(dataset: string, params: Params): Promise<T[]> {
  const token = process.env.FINMIND_TOKEN;
  const url = new URL(BASE_URL);
  url.searchParams.set('dataset', dataset);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  if (token) url.searchParams.set('token', token);

  const { ok, status, body } = await fetchJson<FinMindResponse<T>>(url, {
    label: `finmind ${dataset}`,
    // 402 / 429 是額度用完，要等久一點才有意義
    retryStatus: [402, 429],
    backoffMs: 5_000,
  });

  if (!ok) throw new FinMindError(body.msg ?? `HTTP ${status}`, status, dataset);
  return body.data ?? [];
}

export interface StockInfoRow {
  industry_category: string;
  stock_id: string;
  stock_name: string;
  /** twse=上市 / tpex=上櫃 / emerging=興櫃 */
  type: string;
  date: string;
}

/** 這些不是個股，是大盤 / 統計用的虛擬代號，要濾掉 */
const NON_STOCK_CATEGORIES = new Set(['Index', '大盤', '所有證券']);

/**
 * 股票主檔。原始資料同一個 stock_id 會出現多列（產業分類有新舊兩種寫法），
 * 取 date 最新的那一列。
 */
export async function fetchStockInfo(): Promise<StockInfoRow[]> {
  const rows = await request<StockInfoRow>('TaiwanStockInfo', {});

  const best = new Map<string, StockInfoRow>();
  for (const row of rows) {
    if (!row.stock_id || NON_STOCK_CATEGORIES.has(row.industry_category)) continue;
    const prev = best.get(row.stock_id);
    if (!prev || row.date > prev.date) best.set(row.stock_id, row);
  }
  return [...best.values()].sort((a, b) => a.stock_id.localeCompare(b.stock_id));
}

export interface BalanceSheetRow {
  date: string;
  stock_id: string;
  type: string;
  value: number;
  origin_name: string;
}

/** 資產負債表（逐檔）。Phase 2 補季頻資料時會用到。 */
export async function fetchBalanceSheet(
  stockId: string,
  startDate: string,
  endDate: string,
): Promise<BalanceSheetRow[]> {
  return request<BalanceSheetRow>('TaiwanStockBalanceSheet', {
    data_id: stockId,
    start_date: startDate,
    end_date: endDate,
  });
}

export interface DividendRow {
  date: string;
  stock_id: string;
  /** 所屬期別，季配是「114年第3季」，年配與 ETF 是「115」 */
  year: string;
  StockEarningsDistribution: number;
  StockStatutorySurplus: number;
  StockExDividendTradingDate: string;
  CashEarningsDistribution: number;
  CashStatutorySurplus: number;
  CashExDividendTradingDate: string;
  CashDividendPaymentDate: string;
}

/**
 * 配息紀錄（逐檔）。
 *
 * 實測涵蓋 ETF：0056 有 20 筆、00878 有 25 筆，
 * 而交易所的 BWIBBU 報表完全不含 ETF。
 */
export async function fetchDividends(
  stockId: string,
  startDate: string,
): Promise<DividendRow[]> {
  return request<DividendRow>('TaiwanStockDividend', {
    data_id: stockId,
    start_date: startDate,
  });
}

export interface PriceRow {
  date: string;
  stock_id: string;
  Trading_Volume: number;
  Trading_money: number;
  open: number;
  max: number;
  min: number;
  close: number;
}

/** 個股日頻價量（逐檔）。一次呼叫就拿到十年，約 2,900 筆 / 500KB。 */
export async function fetchPriceHistory(stockId: string, startDate: string): Promise<PriceRow[]> {
  return request<PriceRow>('TaiwanStockPrice', { data_id: stockId, start_date: startDate });
}

export interface PerRow {
  date: string;
  stock_id: string;
  dividend_yield: number | null;
  PER: number | null;
  PBR: number | null;
}

/**
 * 個股日頻評價（逐檔）。
 * ETF 與興櫃交易所不公告，這支會回空陣列。
 */
export async function fetchPerHistory(stockId: string, startDate: string): Promise<PerRow[]> {
  return request<PerRow>('TaiwanStockPER', { data_id: stockId, start_date: startDate });
}

export interface StatementRow {
  date: string;
  stock_id: string;
  type: string;
  value: number;
  origin_name: string;
}

/**
 * 綜合損益表（逐檔）。一次呼叫拿 42 期（2016Q1~2026Q2）。
 *
 * 這裡的數字是「單季」，不是累計——實測台積電 2026
 * Q1(1,134,103,440,000) + Q2(1,270,380,250,000) = 2,404,483,690,000，
 * 與證交所公告的上半年累計完全相同，EPS 22.08 + 27.25 = 49.33 也相同。
 */
export async function fetchStatements(stockId: string, startDate: string): Promise<StatementRow[]> {
  return request<StatementRow>('TaiwanStockFinancialStatements', {
    data_id: stockId,
    start_date: startDate,
  });
}

/**
 * 資產負債表（逐檔）。期末時點數，不能加總也不能相減。
 *
 * 注意 type = EquityAttributableToOwnersOfParent 在兩支 API 裡意義不同：
 *   損益表   → 淨利（淨損）歸屬於母公司業主
 *   資產負債 → 歸屬於母公司業主之權益合計
 * 兩者不能混用，所以各自解析、不共用對照表。
 */
export async function fetchBalanceSheetFull(
  stockId: string,
  startDate: string,
): Promise<StatementRow[]> {
  return request<StatementRow>('TaiwanStockBalanceSheet', {
    data_id: stockId,
    start_date: startDate,
  });
}
