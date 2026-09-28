/**
 * 證交所（TWSE）／櫃買中心（TPEx）官方 open API。
 *
 * 為什麼用這個而不是 FinMind：
 *   免費、不需 token、沒有請求上限，而且「一次呼叫拿全市場單日」，
 *   同樣一天的資料 FinMind register 層要逐檔打 3,000+ 次才拿得到。
 *
 * 限制：這些 endpoint 只提供「最新一個交易日」，不吃日期參數。
 *   → 適合每日增量（GitHub Actions 每天跑一次）
 *   → 歷史回補要另外走帶日期參數的舊版報表 API，屬於後面的階段
 *
 * 數值一律保持 string 傳遞，最後由 Postgres 轉 numeric/bigint。
 * 中途轉成 JS number 會讓大額成交金額與價格精度流失。
 */

export type Market = 'twse' | 'tpex' | 'emerging';

export interface DailyQuote {
  stockId: string;
  /** YYYY-MM-DD */
  tradeDate: string;
  /** 收盤價 */
  close: string | null;
  /** 成交股數 */
  volume: string | null;
  /** 成交金額（元） */
  turnover: string | null;
}

export interface Valuation {
  stockId: string;
  tradeDate: string;
  /** 殖利率(%) */
  dividendYield: string | null;
  /** 本益比 */
  per: string | null;
  /** 股價淨值比 */
  pbr: string | null;
}

export interface CompanyProfile {
  stockId: string;
  name: string;
  market: Market;
  /** 資料出表日 YYYY-MM-DD */
  asOfDate: string;
  /** 實收資本額（元） */
  capital: string | null;
}

/** 民國日期 1150924 → 2026-09-24 */
export function rocToIso(roc: string): string {
  const s = String(roc).trim();
  if (!/^\d{6,7}$/.test(s)) throw new Error(`無法解析的民國日期: ${roc}`);
  const mmdd = s.slice(-4);
  const year = Number(s.slice(0, -4)) + 1911;
  return `${year}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`;
}

/** 官方報表用 "" / "--" / "---" 表示沒有值，不能當成 0 */
function num(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/,/g, '').trim();
  if (s === '' || /^-+$/.test(s) || s === 'N/A') return null;
  return Number.isFinite(Number(s)) ? s : null;
}

async function getJson<T>(label: string, url: string): Promise<T[]> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${label} 取得失敗: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error(`${label} 回傳格式非陣列`);
  return body as T[];
}

// ── 上市 ─────────────────────────────────────────────────────────

export async function fetchTwseQuotes(): Promise<DailyQuote[]> {
  type Row = {
    Date: string; Code: string; TradeVolume: string;
    TradeValue: string; ClosingPrice: string;
  };
  const rows = await getJson<Row>(
    '上市日成交',
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  );
  return rows.map((r) => ({
    stockId: r.Code,
    tradeDate: rocToIso(r.Date),
    close: num(r.ClosingPrice),
    volume: num(r.TradeVolume),
    turnover: num(r.TradeValue),
  }));
}

export async function fetchTwseValuation(): Promise<Valuation[]> {
  type Row = { Date: string; Code: string; PEratio: string; DividendYield: string; PBratio: string };
  const rows = await getJson<Row>(
    '上市本益比殖利率',
    'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
  );
  return rows.map((r) => ({
    stockId: r.Code,
    tradeDate: rocToIso(r.Date),
    dividendYield: num(r.DividendYield),
    per: num(r.PEratio),
    pbr: num(r.PBratio),
  }));
}

// ── 上櫃 ─────────────────────────────────────────────────────────

export async function fetchTpexQuotes(): Promise<DailyQuote[]> {
  type Row = {
    Date: string; SecuritiesCompanyCode: string; Close: string;
    TradingShares: string; TransactionAmount: string;
  };
  const rows = await getJson<Row>(
    '上櫃日收盤',
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  );
  return rows.map((r) => ({
    stockId: r.SecuritiesCompanyCode,
    tradeDate: rocToIso(r.Date),
    close: num(r.Close),
    volume: num(r.TradingShares),
    turnover: num(r.TransactionAmount),
  }));
}

export async function fetchTpexValuation(): Promise<Valuation[]> {
  type Row = {
    Date: string; SecuritiesCompanyCode: string;
    PriceEarningRatio: string; YieldRatio: string; PriceBookRatio: string;
  };
  const rows = await getJson<Row>(
    '上櫃本益比',
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis',
  );
  return rows.map((r) => ({
    stockId: r.SecuritiesCompanyCode,
    tradeDate: rocToIso(r.Date),
    dividendYield: num(r.YieldRatio),
    per: num(r.PriceEarningRatio),
    pbr: num(r.PriceBookRatio),
  }));
}

// ── 興櫃 ─────────────────────────────────────────────────────────

/**
 * 興櫃沒有集中撮合，所以沒有「收盤價」與「成交金額」：
 *   close  取當日最新成交價（LatestPrice），沒有就退而用當日均價
 *   turnover 官方沒提供，維持 null
 */
export async function fetchEmergingQuotes(): Promise<DailyQuote[]> {
  type Row = {
    Date: string; SecuritiesCompanyCode: string;
    LatestPrice: string; Average: string; TransactionVolume: string;
  };
  const rows = await getJson<Row>(
    '興櫃行情',
    'https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics',
  );
  return rows.map((r) => ({
    stockId: r.SecuritiesCompanyCode,
    tradeDate: rocToIso(r.Date),
    close: num(r.LatestPrice) ?? num(r.Average),
    volume: num(r.TransactionVolume),
    turnover: null,
  }));
}

// ── 公司基本資料（股本來源）───────────────────────────────────────

export async function fetchCompanyProfiles(): Promise<CompanyProfile[]> {
  type TwseRow = {
    '出表日期': string; '公司代號': string; '公司簡稱': string; '實收資本額': string;
  };
  type TpexRow = {
    Date: string; SecuritiesCompanyCode: string; CompanyAbbreviation: string;
    'Paidin.Capital.NTDollars': string;
  };

  const [twse, tpex, emerging] = await Promise.all([
    getJson<TwseRow>('上市公司基本資料', 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L'),
    getJson<TpexRow>('上櫃公司基本資料', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O'),
    getJson<TpexRow>('興櫃公司基本資料', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R'),
  ]);

  const fromTpex = (rows: TpexRow[], market: Market): CompanyProfile[] =>
    rows.map((r) => ({
      stockId: r.SecuritiesCompanyCode,
      name: r.CompanyAbbreviation,
      market,
      asOfDate: rocToIso(r.Date),
      capital: num(r['Paidin.Capital.NTDollars']),
    }));

  return [
    ...twse.map((r) => ({
      stockId: r['公司代號'],
      name: r['公司簡稱'],
      market: 'twse' as Market,
      asOfDate: rocToIso(r['出表日期']),
      capital: num(r['實收資本額']),
    })),
    ...fromTpex(tpex, 'tpex'),
    ...fromTpex(emerging, 'emerging'),
  ];
}
