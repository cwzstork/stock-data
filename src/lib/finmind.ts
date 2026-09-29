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
