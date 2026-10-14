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

import { fetchJson } from './http';

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
  /** 已發行普通股數。算董監持股比例的分母 */
  issuedShares: string | null;
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
  const { ok, status, body } = await fetchJson<unknown>(url, { label });
  if (!ok) throw new Error(`${label} 取得失敗: HTTP ${status}`);
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
    '已發行普通股數或TDR原股發行股數': string;
  };
  type TpexRow = {
    Date: string; SecuritiesCompanyCode: string; CompanyAbbreviation: string;
    'Paidin.Capital.NTDollars': string; IssueShares: string;
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
      issuedShares: num(r.IssueShares),
    }));

  return [
    ...twse.map((r) => ({
      stockId: r['公司代號'],
      name: r['公司簡稱'],
      market: 'twse' as Market,
      asOfDate: rocToIso(r['出表日期']),
      capital: num(r['實收資本額']),
      issuedShares: num(r['已發行普通股數或TDR原股發行股數']),
    })),
    ...fromTpex(tpex, 'tpex'),
    ...fromTpex(emerging, 'emerging'),
  ];
}

// ── 內部人持股 ───────────────────────────────────────────────────

export interface InsiderHolding {
  stockId: string;
  /** 資料所屬月份的月底 */
  periodEnd: string;
  directorShares: string;
  directorPledged: string;
  managerShares: string;
  majorShares: string;
}

/**
 * 職稱分類。
 *
 * 判斷順序不能換：先看董監，再看大股東，最後才看經理人。
 * 「副總經理」「協理」都含「理」，若先比對經理人會把董事類誤判進去。
 */
function classify(title: string): 'director' | 'manager' | 'major' | null {
  if (/董事|監察人/.test(title)) return 'director';
  if (/大股東/.test(title)) return 'major';
  if (/經理|協理|副理|主管/.test(title)) return 'manager';
  return null;
}

/** 民國年月 11508 → 2026-08-31（該月最後一天） */
function rocMonthEnd(ym: string): string | null {
  const s = String(ym).trim();
  if (!/^\d{5,6}$/.test(s)) return null;
  const year = Number(s.slice(0, -2)) + 1911;
  const month = Number(s.slice(-2));
  if (month < 1 || month > 12) return null;
  // 下個月的第 0 天就是這個月的最後一天
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

/**
 * 董監事、經理人、大股東持股（全市場一次呼叫，上市與上櫃各一支）。
 *
 * 上游是「一人一列」，同一個人可能因為兼多個職位而出現好幾列，
 * 而每一列都記他的「全部持股」。直接加總會嚴重高估——
 * 中華電的交通部掛董事長、七席董事、大股東共九列，每列都是 2,737,718,976 股，
 * 加起來持股比例會變成 317%。
 * 所以每一類別內都要先依姓名去重（同一人取最大值）再加總，
 * 去重後中華電是 35.31%，符合交通部實際持股。
 */
export async function fetchInsiderHoldings(): Promise<InsiderHolding[]> {
  type Row = {
    '資料年月': string;
    '公司代號': string;
    '職稱': string;
    '姓名': string;
    '目前持股': string;
    '設質股數': string;
  };

  const [twse, tpex] = await Promise.all([
    getJson<Row>('上市董監持股', 'https://openapi.twse.com.tw/v1/opendata/t187ap11_L'),
    getJson<Row>('上櫃董監持股', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap11_O'),
  ]);

  // key = stockId|periodEnd，每一類別各自維護「姓名 → 最大持股」
  interface Bucket {
    director: Map<string, { hold: number; pledge: number }>;
    manager: Map<string, { hold: number; pledge: number }>;
    major: Map<string, { hold: number; pledge: number }>;
  }
  const byStock = new Map<string, Bucket>();

  for (const r of [...twse, ...tpex]) {
    const stockId = String(r['公司代號'] ?? '').trim();
    const periodEnd = rocMonthEnd(r['資料年月']);
    const kind = classify(String(r['職稱'] ?? ''));
    if (!stockId || !periodEnd || !kind) continue;

    const key = `${stockId}|${periodEnd}`;
    let b = byStock.get(key);
    if (!b) {
      b = { director: new Map(), manager: new Map(), major: new Map() };
      byStock.set(key, b);
    }
    const name = String(r['姓名'] ?? '').trim() || `匿名${b[kind].size}`;
    const hold = Number(String(r['目前持股'] ?? '').replace(/[, ]/g, '')) || 0;
    const pledge = Number(String(r['設質股數'] ?? '').replace(/[, ]/g, '')) || 0;
    const prev = b[kind].get(name);
    if (!prev || hold > prev.hold) b[kind].set(name, { hold, pledge });
  }

  const sum = (m: Map<string, { hold: number; pledge: number }>, f: 'hold' | 'pledge') =>
    [...m.values()].reduce((a, v) => a + v[f], 0);

  return [...byStock.entries()]
    .map(([key, b]) => {
      const [stockId, periodEnd] = key.split('|');
      return {
        stockId,
        periodEnd,
        directorShares: String(sum(b.director, 'hold')),
        directorPledged: String(sum(b.director, 'pledge')),
        managerShares: String(sum(b.manager, 'hold')),
        majorShares: String(sum(b.major, 'hold')),
      };
    })
    .sort((a, b) => a.stockId.localeCompare(b.stockId));
}

// ── 月營收 ───────────────────────────────────────────────────────

export interface MonthlyRevenue {
  stockId: string;
  /** 所屬月份的 1 日 */
  month: string;
  /** 當月營收，單位：元 */
  revenue: string;
}

/**
 * 全市場月營收（上市與上櫃各一次呼叫）。
 *
 * 興櫃不強制公告月營收，所以沒有對應的 endpoint（_R 回 302）。
 * 上游單位是千元，這裡 ×1000 存成元，跟其他表一致。
 */
export async function fetchMonthlyRevenue(): Promise<MonthlyRevenue[]> {
  type Row = {
    '資料年月': string;
    '公司代號': string;
    '營業收入-當月營收': string;
  };

  const [twse, tpex] = await Promise.all([
    getJson<Row>('上市月營收', 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L'),
    getJson<Row>('上櫃月營收', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O'),
  ]);

  const out: MonthlyRevenue[] = [];
  for (const r of [...twse, ...tpex]) {
    const stockId = String(r['公司代號'] ?? '').trim();
    const ym = String(r['資料年月'] ?? '').trim();
    if (!stockId || !/^\d{5,6}$/.test(ym)) continue;
    const year = Number(ym.slice(0, -2)) + 1911;
    const month = Number(ym.slice(-2));
    if (month < 1 || month > 12) continue;

    const raw = num(r['營業收入-當月營收']);
    if (raw === null) continue;
    // 千元 → 元。用 BigInt 避免大額營收在 JS number 失去精度
    const revenue = BigInt(Math.round(Number(raw) * 1000)).toString();

    out.push({
      stockId,
      month: `${year}-${String(month).padStart(2, '0')}-01`,
      revenue,
    });
  }
  return out;
}

// ── 休市行事曆 ───────────────────────────────────────────────────

export interface MarketHoliday {
  /** YYYY-MM-DD */
  date: string;
  name: string;
  description: string;
}

/**
 * 證交所公告的休市行事曆。
 *
 * 這份清單裡混了兩種紀錄，整份當成休市會算錯：
 *   休市 —「依規定放假」「補假」「市場無交易，僅辦理結算交割作業」
 *   開市 —「國曆新年開始交易日」「農曆春節前最後交易日」「農曆春節後開始交易日」
 * 後者是「特別標註的交易日」，那幾天照樣要有行情，不能被當成休市漏掉。
 *
 * 只涵蓋當年度（民國年）。跨年時查不到去年十二月，
 * 呼叫端要自己判斷涵蓋範圍，不要把「查不到」當成「有開市」。
 */
export async function fetchMarketHolidays(): Promise<MarketHoliday[]> {
  type Row = { Name: string; Date: string; Weekday: string; Description: string };
  const rows = await getJson<Row>(
    '休市行事曆',
    'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule',
  );
  return rows
    .filter((r) => !/開始交易|最後交易/.test(`${r.Name ?? ''}${r.Description ?? ''}`))
    .map((r) => ({
      date: rocToIso(r.Date),
      name: String(r.Name ?? '').trim(),
      description: String(r.Description ?? '').replace(/<br>/g, '').trim(),
    }));
}

/**
 * 某個日期證交所到底有沒有開市。
 *
 * 為什麼光看行事曆不夠：`fetchMarketHolidays()` 來源是「預先公告」的國定假日，
 * 不含颱風假這種當天才宣布的臨時休市。2026-07-10 就是這種——
 * 行事曆說它是交易日，但全市場一筆資料都沒有。
 * 只靠行事曆判斷缺日，每個颱風天都會誤報一次。
 *
 * 這支打的是帶日期參數的舊版報表（openapi 那組一律不吃日期）：
 *   有開市 → {"stat":"OK", ...}
 *   沒開市 → {"stat":"很抱歉，沒有符合條件的資料!"}
 *
 * 用 type=MS（大盤統計）而不是 type=ALL：同樣的 stat 語意，
 * 但回應 1.2 KB 而不是 4 MB，而這支只是拿來問「有沒有開市」。
 *
 * 回傳 null = 問不到（連線失敗、或格式又變了）。
 * 呼叫端要把 null 當成「不確定」而不是「沒開市」，
 * 否則真的掉資料時會被這支默默吃掉。
 */
export async function fetchTwseMarketOpen(isoDate: string): Promise<boolean | null> {
  const compact = isoDate.replace(/-/g, '');
  const url =
    'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX' +
    `?date=${compact}&type=MS&response=json`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // 不用 JSON.parse：這支偶爾會吐出 parse 吃不下的內容，而我們只要 stat
    const stat = /"stat"\s*:\s*"([^"]*)"/.exec(text)?.[1];
    if (!stat) return null;
    if (stat === 'OK') return true;
    if (stat.includes('沒有符合條件')) return false;
    return null;
  } catch {
    return null;
  }
}
