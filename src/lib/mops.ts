/**
 * 季頻財報：綜合損益表（t187ap06）與資產負債表（t187ap07）。
 *
 * 來源同樣是證交所 / 櫃買中心官方 open API，免 token、無請求上限。
 * 兩張表各依行業別拆成 6 種，上市上櫃合計 24 次呼叫拿到全市場一季。
 *
 * 實測（2026-09-29）踩到的兩件事，不能靠猜：
 *
 * 1. 各行業別的欄位名不一樣。
 *    金融業沒有「營業毛利」，金控業的營收叫「淨收益」，證券期貨業叫「收益」，
 *    稅前淨利有四種寫法。所以每個欄位都要用別名清單去試。
 *
 * 2. 櫃買的 meta 欄位有三種命名混用：
 *      Date / Year / Season / SecuritiesCompanyCode
 *      Date / 年度 / 季別 / SecuritiesCompanyCode
 *      出表日期 / 年度 / 季別 / 公司代號
 *    同一組 endpoint 裡就不一致，一樣要用別名。
 *
 * 金額單位：上游是「千元」，這裡一律 ×1000 存成「元」，跟 stock_capital 對齊。
 * ×1000 是整數運算不會失真，而兩張表單位不同才是真正會出事的地雷。
 */

import { fetchJson, mapLimit } from './http';

/** 行業別。證交所把財報依這六類拆檔，欄位結構各不相同。 */
const SECTORS = ['ci', 'mim', 'basi', 'bd', 'fh', 'ins'] as const;
type Sector = (typeof SECTORS)[number];

type Row = Record<string, string>;

/** 依序試每個欄位名，回傳第一個有值的 */
function pick(row: Row, ...names: string[]): string | null {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/** 千元 → 元。保持字串運算，不經過 JS number。 */
function toYuan(thousands: string | null): string | null {
  if (thousands === null) return null;
  const n = Number(thousands.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return BigInt(Math.round(n * 1000)).toString();
}

function toDecimal(v: string | null): string | null {
  if (v === null) return null;
  const s = v.replace(/,/g, '');
  return Number.isFinite(Number(s)) ? s : null;
}

/** 民國年 + 季別 → 季底日。115 / 2 → 2026-06-30 */
function periodEnd(rocYear: string | null, season: string | null): string | null {
  if (!rocYear || !season) return null;
  const y = Number(rocYear) + 1911;
  const q = Number(season);
  if (!Number.isFinite(y) || ![1, 2, 3, 4].includes(q)) return null;
  return `${y}-${['03-31', '06-30', '09-30', '12-31'][q - 1]}`;
}

export interface QuarterlyRow {
  stockId: string;
  /** 季底日 YYYY-MM-DD */
  periodEnd: string;

  // ── 損益表：累計數（Q2 = 上半年累計，不是單季）。單位：元 ──
  revenue: string | null;
  grossProfit: string | null;
  operatingIncome: string | null;
  pretaxIncome: string | null;
  netIncome: string | null;
  /** 歸屬於母公司業主，算 ROE / EPS 要用這個而不是本期淨利 */
  netIncomeParent: string | null;
  /** 基本每股盈餘（元），累計 */
  eps: string | null;

  // ── 資產負債表：期末時點數，不是累計。單位：元 ──
  /** 流動資產／流動負債，算流動比率用 */
  currentAssets: string | null;
  currentLiabilities: string | null;
  totalAssets: string | null;
  totalLiabilities: string | null;
  totalEquity: string | null;
  equityParent: string | null;
  /** 每股參考淨值（元） */
  bookValuePerShare: string | null;
}

async function getRows(label: string, url: string): Promise<Row[]> {
  const { ok, status, body } = await fetchJson<unknown>(url, { label });
  if (!ok) throw new Error(`${label} 取得失敗: HTTP ${status}`);
  if (!Array.isArray(body)) throw new Error(`${label} 回傳格式非陣列`);
  return body as Row[];
}

const META = {
  code: ['公司代號', 'SecuritiesCompanyCode'],
  year: ['年度', 'Year'],
  season: ['季別', 'Season'],
} as const;

function metaOf(r: Row) {
  return {
    stockId: pick(r, ...META.code),
    period: periodEnd(pick(r, ...META.year), pick(r, ...META.season)),
  };
}

type Partial_ = Omit<QuarterlyRow, 'stockId' | 'periodEnd'>;

const EMPTY: Partial_ = {
  currentAssets: null,
  currentLiabilities: null,
  revenue: null,
  grossProfit: null,
  operatingIncome: null,
  pretaxIncome: null,
  netIncome: null,
  netIncomeParent: null,
  eps: null,
  totalAssets: null,
  totalLiabilities: null,
  totalEquity: null,
  equityParent: null,
  bookValuePerShare: null,
};

/**
 * 每個行業別明確指定要用哪個欄位，不用別名去猜。
 *
 * 2026-09-29 逐一驗算的結果（拿報表內部應該成立的恆等式去對）：
 *
 *   ci   一般業     台積電 EPS 與每股淨值用股本反算完全吻合 → 全部可用
 *   mim  異業       收入 − 支出 = 稅前，四家全中 → 可用（本來就沒有毛利/營益）
 *   bd   證券期貨   收益 − 支出及費用 = 營業利益，三家全中 → 可用
 *   basi 銀行       利息淨收益 + 利息以外淨損益 − 呆帳 − 營業費用 = 稅前，完全吻合
 *                   → 欄位可信，但銀行沒有單一「營業收入」概念，revenue 留空
 *   fh   金控       「淨收益」對不上利息淨收益＋利息以外淨收益，
 *                   而且 13 家全部「稅前淨利 < 稅後淨利」——會計上不可能。
 *                   上游欄位與值錯位 → 除了淨利與 EPS 之外一律不採用
 *   ins  保險       旺旺保營益 1,931,456 > 營收 930,279；
 *                   中再保營益是營收的 6 倍 → 營收與營業利益不可信，不採用
 *
 * 結論：毛利率只有一般業算得出來，營益率多了證券期貨業，
 * 淨利率再多異業。ROE／負債比／EPS／每股淨值則是所有行業都有。
 * 寧可留白，也不要在畫面上放一個看起來像數字的錯誤值。
 */
const NET_INCOME = ['本期淨利（淨損）', '本期稅後淨利（淨損）'];
const NET_INCOME_PARENT = ['淨利（淨損）歸屬於母公司業主', '淨利（損）歸屬於母公司業主'];

type FieldMap = {
  revenue: string[];
  grossProfit: string[];
  operatingIncome: string[];
  pretaxIncome: string[];
};

const INCOME_FIELDS: Record<Sector, FieldMap> = {
  ci: {
    revenue: ['營業收入'],
    grossProfit: ['營業毛利（毛損）淨額', '營業毛利（毛損）'],
    operatingIncome: ['營業利益（損失）'],
    pretaxIncome: ['稅前淨利（淨損）'],
  },
  mim: {
    revenue: ['收入'],
    grossProfit: [],
    operatingIncome: [],
    pretaxIncome: ['繼續營業單位稅前淨利（淨損）'],
  },
  bd: {
    revenue: ['收益'],
    grossProfit: [],
    operatingIncome: ['營業利益'],
    pretaxIncome: ['稅前淨利（淨損）'],
  },
  basi: {
    revenue: [],
    grossProfit: [],
    operatingIncome: [],
    pretaxIncome: ['繼續營業單位稅前淨利（淨損）'],
  },
  fh: {
    revenue: [],
    grossProfit: [],
    operatingIncome: [],
    pretaxIncome: [],
  },
  ins: {
    revenue: [],
    grossProfit: [],
    operatingIncome: [],
    pretaxIncome: ['繼續營業單位稅前純益（純損）'],
  },
};

function parseIncome(r: Row, sector: Sector): Partial<Partial_> {
  const f = INCOME_FIELDS[sector];
  return {
    revenue: toYuan(pick(r, ...f.revenue)),
    grossProfit: toYuan(pick(r, ...f.grossProfit)),
    operatingIncome: toYuan(pick(r, ...f.operatingIncome)),
    pretaxIncome: toYuan(pick(r, ...f.pretaxIncome)),
    netIncome: toYuan(pick(r, ...NET_INCOME)),
    netIncomeParent: toYuan(pick(r, ...NET_INCOME_PARENT)),
    eps: toDecimal(pick(r, '基本每股盈餘（元）')),
  };
}

function parseBalance(r: Row): Partial<Partial_> {
  return {
    // 銀行、金控、保險的資產負債表沒有「流動／非流動」之分，會是 null，
    // 流動比率對這些行業本來就不適用
    currentAssets: toYuan(pick(r, '流動資產')),
    currentLiabilities: toYuan(pick(r, '流動負債')),
    totalAssets: toYuan(pick(r, '資產總計', '資產總額')),
    totalLiabilities: toYuan(pick(r, '負債總計', '負債總額')),
    totalEquity: toYuan(pick(r, '權益總計', '權益總額')),
    equityParent: toYuan(
      pick(
        r,
        '歸屬於母公司業主之權益合計',
        '歸屬於母公司業主權益合計',
        '歸屬於母公司業主之權益',
      ),
    ),
    bookValuePerShare: toDecimal(pick(r, '每股參考淨值')),
  };
}

const TWSE = (ap: '06' | '07', sector: string) =>
  `https://openapi.twse.com.tw/v1/opendata/t187ap${ap}_L_${sector}`;
const TPEX = (ap: '06' | '07', sector: string) =>
  `https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap${ap}_O_${sector}`;

/**
 * 抓全市場最新一季的財報並合併損益表與資產負債表。
 *
 * 跟日頻一樣，這些 endpoint 只給「最新一季」，不吃期別參數。
 * 十年歷史要另外走 FinMind 逐檔回補。
 */
export async function fetchQuarterly(): Promise<QuarterlyRow[]> {
  const jobs: { kind: 'income' | 'balance'; sector: Sector; label: string; url: string }[] = [];

  for (const sector of SECTORS) {
    for (const [market, url] of [
      ['上市', TWSE],
      ['上櫃', TPEX],
    ] as const) {
      jobs.push({ kind: 'income', sector, label: `${market}損益表 ${sector}`, url: url('06', sector) });
      jobs.push({ kind: 'balance', sector, label: `${market}資產負債表 ${sector}`, url: url('07', sector) });
    }
  }

  // 24 支一次全發出去，對方或中間代理很容易切連線，限制同時 4 條
  const results = await mapLimit(jobs, 4, async (j) => ({
    kind: j.kind,
    sector: j.sector,
    rows: await getRows(j.label, j.url),
  }));

  // key = stockId|periodEnd，損益表與資產負債表各補自己那一半
  const merged = new Map<string, QuarterlyRow>();
  for (const { kind, sector, rows } of results) {
    for (const r of rows) {
      const { stockId, period } = metaOf(r);
      if (!stockId || !period) continue;
      const key = `${stockId}|${period}`;
      const cur =
        merged.get(key) ?? ({ ...EMPTY, stockId, periodEnd: period } satisfies QuarterlyRow);
      merged.set(key, {
        ...cur,
        ...(kind === 'income' ? parseIncome(r, sector) : parseBalance(r)),
      });
    }
  }

  return [...merged.values()].sort(
    (a, b) => a.stockId.localeCompare(b.stockId) || a.periodEnd.localeCompare(b.periodEnd),
  );
}
