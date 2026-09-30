import Link from 'next/link';
import { deleteFilter, listSavedFilters, saveFilter } from '@/lib/saved-filter';
import {
  MARKET_LABEL,
  PAGE_SIZES,
  getIndustries,
  getTradeDates,
  getPeriodInfo,
  parseFilters,
  runScreener,
  type Filters,
  type RawParams,
  type ScreenerRow,
  type SortKey,
} from '@/lib/screener';

export const dynamic = 'force-dynamic';

// ── 格式化 ────────────────────────────────────────────────────────

const dash = <span className="text-zinc-400 dark:text-zinc-600">—</span>;

function fmt(v: string | null, digits: number) {
  if (v === null) return dash;
  return Number(v).toLocaleString('zh-TW', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 成交量資料庫存「股」，畫面顯示「張」 */
function lots(v: string | null) {
  if (v === null) return dash;
  return Math.round(Number(v) / 1000).toLocaleString('zh-TW');
}

/** 成交金額顯示千元、股本顯示百萬元 */
function scaled(v: string | null, divisor: number) {
  if (v === null) return dash;
  return Math.round(Number(v) / divisor).toLocaleString('zh-TW');
}

// ── 表單零件 ──────────────────────────────────────────────────────

const inputCls =
  'w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm ' +
  'dark:border-zinc-700 dark:bg-zinc-900';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

function Range({
  label,
  name,
  min,
  max,
}: {
  label: string;
  name: string;
  min: number | null;
  max: number | null;
}) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step="any"
          name={`${name}Min`}
          defaultValue={min ?? ''}
          placeholder="最小"
          className={inputCls}
        />
        <span className="text-zinc-400">~</span>
        <input
          type="number"
          step="any"
          name={`${name}Max`}
          defaultValue={max ?? ''}
          placeholder="最大"
          className={inputCls}
        />
      </div>
    </Field>
  );
}

// ── 連結組裝 ──────────────────────────────────────────────────────

/** 保留現有條件，只換掉指定的幾個 key */
function withParams(params: RawParams, drop: string[], set: Record<string, string> = {}) {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (drop.includes(k)) continue;
    for (const one of Array.isArray(v) ? v : v ? [v] : []) next.append(k, one);
  }
  for (const [k, v] of Object.entries(set)) next.set(k, v);
  return next.toString();
}

function sortHref(params: RawParams, f: Filters, key: SortKey) {
  // 點同一欄翻轉方向；點別欄一律先由大到小（篩選器多半想看排前面的）
  const dir = f.sort === key && f.dir === 'desc' ? 'asc' : 'desc';
  return `/?${withParams(params, ['sort', 'dir', 'page'], { sort: key, dir })}`;
}

/**
 * 欄位名一律標出時間基準，因為同一個指標在不同基準下差很多：
 *   (當日)   基準日那一天的值
 *   (單季)   最新那一季
 *   (累計)   該年度年初到最新一季
 *   (近四季) 最近四季加總，ROE 與本益比用這個最準
 *   (當期)   財報期末的時點數，不能加總
 *   (5年)    近 5 個完整年度
 */
/**
 * 欄位標籤依實際資料的期別動態產生。
 *
 * 寫死「累計」「當期」使用者無從得知涵蓋多久，而且那兩個詞在不同欄位
 * 指的還是不同東西——負債比是財報期末、董監持股是公告月、股本是公告日，
 * 三者日期都不一樣。所以一律把實際日期寫進欄位名。
 */
function buildColumns(p: {
  ytdMonths: number | null;
  quarterEnd: string | null;
  capitalDate: string | null;
  insiderDate: string | null;
  revenueMonth: string | null;
  epsYear: number | null;
}): {
  key: SortKey | null;
  label: string;
  right?: boolean;
}[] {
  // 累計的長度隨季別變動：Q1 是 3 個月、Q2 是 6 個月、Q3 是 9、Q4 是 12
  const ytd = p.ytdMonths ? `累計${p.ytdMonths}個月` : '累計';
  // 財報期末給到日，股本公告給到日，內部人持股只到月（資料本身就是月報）
  const qe = p.quarterEnd ?? '財報期末';
  const cap = p.capitalDate ?? '公告日';
  const ins = p.insiderDate ? p.insiderDate.slice(0, 7) : '公告月';
  const rm = p.revenueMonth ?? '最新月';
  // 預估的是「最新已公布月營收所屬年度」的全年 EPS
  const estYear = p.revenueMonth ? `${p.revenueMonth.slice(0, 4)}年` : '年';
  // 年度 EPS 只採四季齊全的年度，所以最新完整年度通常是去年，不是今年
  const ey = p.epsYear ? `${p.epsYear}年` : '最新完整年';
  const eyPrev = p.epsYear ? `${p.epsYear - 1}年` : '前一完整年';
  return [
  { key: 'stock_id', label: '股號' },
  { key: null, label: '股名' },
  { key: null, label: '市場' },
  { key: null, label: '產業' },

  { key: 'close', label: '收盤(當日)', right: true },
  { key: 'volume', label: '成交量(當日,張)', right: true },
  { key: 'turnover', label: '成交額(當日,千元)', right: true },
  { key: 'dividend_yield', label: '殖利率(當日,交易所)%', right: true },
  { key: 'per', label: '本益比(當日,近四季)', right: true },
  { key: 'pbr', label: '股價淨值比(當日)', right: true },
  { key: 'capital', label: `股本(${cap},百萬)`, right: true },

  { key: 'gross_margin_q', label: '毛利率(單季3個月)%', right: true },
  { key: 'gross_margin', label: `毛利率(${ytd})%`, right: true },
  { key: 'op_margin_q', label: '營業利益率(單季3個月)%', right: true },
  { key: 'op_margin', label: `營業利益率(${ytd})%`, right: true },
  { key: 'net_margin_q', label: '稅後淨利率(單季3個月)%', right: true },
  { key: 'net_margin', label: `稅後淨利率(${ytd})%`, right: true },

  { key: 'rev_yoy', label: '營收成長率(單季3個月年增)%', right: true },
  { key: 'op_yoy', label: '營業利益成長率(單季3個月年增)%', right: true },
  { key: 'ni_yoy', label: '稅後淨利成長率(單季3個月年增)%', right: true },

  { key: 'roe_ttm', label: 'ROE(近四季12個月)%', right: true },
  { key: 'roe', label: `ROE(${ytd}年化)%`, right: true },
  { key: 'roa_ttm', label: 'ROA(近四季12個月)%', right: true },
  { key: 'roa', label: `ROA(${ytd}年化)%`, right: true },
  { key: 'debt_ratio', label: `負債比(${qe})%`, right: true },
  { key: 'current_ratio', label: `流動比(${qe})%`, right: true },
  { key: 'eps', label: 'EPS(單季3個月)', right: true },
  { key: 'eps_ttm', label: 'EPS(近四季12個月)', right: true },
  { key: 'bvps', label: `每股淨值(${qe})`, right: true },

  { key: 'eps_grow', label: 'EPS連續成長(年)', right: true },
  { key: 'eps_year', label: `EPS(${ey})`, right: true },
  { key: null, label: `EPS(${eyPrev})`, right: true },

  { key: 'rev_m_yoy', label: `月營收年增(${rm})%`, right: true },
  { key: 'rev_ytd_yoy', label: `營收年增(${estYear}累計)%`, right: true },
  { key: 'est_eps', label: `預估EPS(${estYear},自算)`, right: true },
  { key: 'est_eps_low', label: `保守預估EPS(${estYear},自算)`, right: true },

  { key: 'ttm_yield', label: '年化殖利率(近12月)%', right: true },
  { key: 'ttm_cash', label: '現金股利(近12月)', right: true },
  { key: 'yield5', label: '均殖利率(5年均利÷現價)%', right: true },
  { key: 'yield10', label: '均殖利率(10年均利÷現價)%', right: true },
  { key: 'streak', label: '連續配息(年)', right: true },
  { key: 'hy5', label: '歷史殖利率(5年)%', right: true },
  { key: 'hy10', label: '歷史殖利率(10年)%', right: true },
  { key: 'hy5_min', label: '最低殖利率(5年)%', right: true },
  { key: 'avg_div5', label: '現金股利(5年均)', right: true },
  { key: 'min_per5', label: '最低本益比(5年)', right: true },

  { key: 'cheap_div', label: '便宜價(股利法)', right: true },
  { key: 'cheap_per', label: '便宜價(本益比法)', right: true },
  { key: 'cheap_pbr', label: '便宜價(淨值法)', right: true },

  { key: 'director_pct', label: `董監持股(${ins})%`, right: true },
  { key: 'pledge_pct', label: `董監設質(${ins})%`, right: true },
  { key: 'manager_pct', label: `經理人持股(${ins})%`, right: true },
  { key: 'major_pct', label: `大股東持股(${ins})%`, right: true },

    { key: null, label: '財報期別' },
  ];
}

function Row({ r }: { r: ScreenerRow }) {
  const n = (v: string | null, d = 2) => (
    <td className="px-2 py-1 text-right tabular-nums">{fmt(v, d)}</td>
  );
  const nb = (v: string | null, d = 2) => (
    <td className="px-2 py-1 text-right tabular-nums font-medium">{fmt(v, d)}</td>
  );
  return (
    <tr className="border-b border-zinc-100 hover:bg-amber-50/60 dark:border-zinc-800 dark:hover:bg-zinc-800/60">
      <td className="px-2 py-1 font-mono">{r.stock_id}</td>
      <td className="px-2 py-1 whitespace-nowrap">{r.stock_name}</td>
      <td className="px-2 py-1 whitespace-nowrap text-zinc-500">
        {MARKET_LABEL[r.market] ?? r.market}
      </td>
      <td className="px-2 py-1 whitespace-nowrap text-zinc-500">{r.industry_category ?? dash}</td>

      {nb(r.close)}
      <td className="px-2 py-1 text-right tabular-nums">{lots(r.volume)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{scaled(r.turnover, 1000)}</td>
      {n(r.dividend_yield)}
      {n(r.per)}
      {n(r.pbr)}
      <td className="px-2 py-1 text-right tabular-nums">{scaled(r.capital, 1e6)}</td>

      {n(r.gross_margin_q)}
      {nb(r.gross_margin)}
      {n(r.op_margin_q)}
      {nb(r.op_margin)}
      {n(r.net_margin_q)}
      {nb(r.net_margin)}

      {n(r.rev_yoy)}
      {n(r.op_yoy)}
      {n(r.ni_yoy)}

      {nb(r.roe_ttm)}
      {n(r.roe)}
      {n(r.roa_ttm)}
      {n(r.roa)}
      {n(r.debt_ratio)}
      {n(r.current_ratio)}
      {n(r.eps)}
      {nb(r.eps_ttm)}
      {n(r.bvps)}

      {n(r.eps_grow, 0)}
      {nb(r.eps_year)}
      {n(r.eps_year_prev)}

      {n(r.rev_m_yoy)}
      {n(r.rev_ytd_yoy)}
      {nb(r.est_eps)}
      {nb(r.est_eps_low)}

      {nb(r.ttm_yield)}
      {n(r.ttm_cash)}
      {n(r.yield5)}
      {n(r.yield10)}
      {n(r.streak, 0)}
      {nb(r.hy5)}
      {n(r.hy10)}
      {n(r.hy5_min)}
      {n(r.avg_div5)}
      {n(r.min_per5)}

      {nb(r.cheap_div)}
      {nb(r.cheap_per)}
      {nb(r.cheap_pbr)}

      {n(r.director_pct)}
      {n(r.pledge_pct)}
      {n(r.manager_pct)}
      {n(r.major_pct)}

      <td className="px-2 py-1 whitespace-nowrap text-zinc-500">{r.period_end ?? dash}</td>
    </tr>
  );
}

/** 季底日 → 該季起始日。2026-06-30 → 2026-04-01 */
function quarterStart(quarterEnd: string): string {
  const y = quarterEnd.slice(0, 4);
  const m = Number(quarterEnd.slice(5, 7));
  return `${y}-${String(m - 2).padStart(2, '0')}-01`;
}

/** 季底日 → 近四季的起始日。2026-06-30 → 2025-07-01 */
function ttmStart(quarterEnd: string): string {
  const y = Number(quarterEnd.slice(0, 4)) - 1;
  const m = Number(quarterEnd.slice(5, 7));
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** 交易日 → 往回整整一年的隔天。2026-09-24 → 2025-09-25 */
function ttmDayStart(tradeDate: string): string {
  const d = new Date(`${tradeDate}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── 頁面 ──────────────────────────────────────────────────────────

export default async function Home({ searchParams }: PageProps<'/'>) {
  const params = (await searchParams) as RawParams;
  const f = parseFilters(params);

  // 交易日清單只查一次：下拉選單要用，runScreener 決定基準日也要用
  const dates = await getTradeDates();
  const [result, industries, saved] = await Promise.all([
    runScreener(f, dates),
    getIndustries(),
    listSavedFilters(),
  ]);
  const period = result ? await getPeriodInfo(result.tradeDate) : null;
  const ytdMonths = period?.quarter ? period.quarter * 3 : null;
  const COLUMNS = buildColumns({
    ytdMonths,
    quarterEnd: period?.quarterEnd ?? null,
    capitalDate: period?.capitalDate ?? null,
    insiderDate: period?.insiderDate ?? null,
    revenueMonth: period?.revenueMonth ?? null,
    epsYear: period?.epsYear ?? null,
  });

  // 目前畫面上的條件，原樣拿來存或分享
  const currentQuery = withParams(params, []);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-6">
      <header className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">台股篩選器</h1>
          <Link
            href="/live"
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-amber-600"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
            </span>
            即時報價
          </Link>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          條件都在網址裡，可以加書籤或分享——每次打開都是用當下的資料重跑一次，不會拿到過期的清單。
        </p>
      </header>

      <section className="mb-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-500">已存條件</span>
          {saved.length === 0 && (
            <span className="text-xs text-zinc-400">還沒有。設好條件後在右邊命名存起來。</span>
          )}
          {saved.map((sf) => (
            <span
              key={sf.id}
              className="inline-flex items-center gap-1 rounded-full border border-zinc-300 pl-3 text-sm dark:border-zinc-700"
            >
              <Link href={`/?${sf.query}`} className="py-1 hover:underline" title={sf.query || '(無條件)'}>
                {sf.name}
              </Link>
              <form action={deleteFilter} className="contents">
                <input type="hidden" name="id" value={sf.id} />
                <button
                  type="submit"
                  className="px-2 py-1 text-zinc-400 hover:text-red-600"
                  title="刪除"
                  aria-label={`刪除 ${sf.name}`}
                >
                  ×
                </button>
              </form>
            </span>
          ))}
        </div>

        <form action={saveFilter} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="query" value={currentQuery} />
          <input
            name="name"
            required
            maxLength={60}
            placeholder="幫目前這組條件取個名字，例如：高毛利存股"
            className={`${inputCls} max-w-md flex-1`}
          />
          <button
            type="submit"
            className="rounded border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700"
          >
            存起來
          </button>
          <span className="text-xs text-zinc-400">
            存的是條件不是結果——每次打開都用當下資料重跑。同名會覆蓋。
          </span>
        </form>
      </section>

      <form method="get" className="mb-5 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="基準日">
            <select name="date" defaultValue={result?.tradeDate ?? ''} className={inputCls}>
              {dates.map((d) => (
                <option key={d.date} value={d.date}>
                  {d.date}（{d.count.toLocaleString('zh-TW')} 檔）
                </option>
              ))}
            </select>
          </Field>

          <Field label="產業">
            <select name="industry" defaultValue={f.industry ?? ''} className={inputCls}>
              <option value="">不限</option>
              {industries.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </Field>

          <Field label="股號 / 股名">
            <input
              name="q"
              defaultValue={f.q ?? ''}
              placeholder="例：2330 或 台積"
              className={inputCls}
            />
          </Field>

          <Range label="殖利率 (%)" name="yield" min={f.yieldMin} max={f.yieldMax} />
          <Range label="本益比" name="per" min={f.perMin} max={f.perMax} />
          <Range label="股價淨值比" name="pbr" min={f.pbrMin} max={f.pbrMax} />
          <Range label="收盤價" name="close" min={f.closeMin} max={f.closeMax} />
          <Range label="股本 (百萬元)" name="cap" min={f.capMin} max={f.capMax} />

          <Range label="毛利率 (%)" name="gm" min={f.gmMin} max={f.gmMax} />
          <Range label="營業利益率 (%)" name="om" min={f.omMin} max={f.omMax} />
          <Range label="淨利率 (%)" name="nm" min={f.nmMin} max={f.nmMax} />
          <Range label="ROE 年化 (%)" name="roe" min={f.roeMin} max={f.roeMax} />
          <Range label="EPS (累計)" name="eps" min={f.epsMin} max={f.epsMax} />

          <Range label="年化殖利率 (%)" name="ty" min={f.tyMin} max={f.tyMax} />

          <Field label="5年均殖下限 (%)">
            <input type="number" step="any" name="y5Min" defaultValue={f.y5Min ?? ''}
              placeholder="例：4" className={inputCls} />
          </Field>

          <Field label="10年均殖下限 (%)">
            <input type="number" step="any" name="y10Min" defaultValue={f.y10Min ?? ''}
              placeholder="例：4" className={inputCls} />
          </Field>

          <Field label="連續配息年數下限">
            <input type="number" name="streakMin" defaultValue={f.streakMin ?? ''}
              placeholder="例：5" className={inputCls} />
          </Field>

          <Field label="5年歷史殖下限 (%)">
            <input type="number" step="any" name="hy5Min" defaultValue={f.hy5Min ?? ''}
              placeholder="例：4" className={inputCls} />
          </Field>

          <Field label="10年歷史殖下限 (%)">
            <input type="number" step="any" name="hy10Min" defaultValue={f.hy10Min ?? ''}
              placeholder="例：4" className={inputCls} />
          </Field>

          <Field label="EPS(年)連續成長年數下限">
            <select name="epsGrowMin" defaultValue={f.epsGrowMin ?? ''} className={inputCls}>
              <option value="">不限</option>
              <option value="3">3 年以上</option>
              <option value="5">5 年以上</option>
              <option value="10">10 年以上</option>
            </select>
          </Field>

          <Field label="5年最低PER 上限">
            <input type="number" step="any" name="minPer5Max" defaultValue={f.minPer5Max ?? ''}
              placeholder="例：12" className={inputCls} />
          </Field>

          <Field label="流動比率下限 (%)">
            <input type="number" step="any" name="crMin" defaultValue={f.crMin ?? ''}
              placeholder="例：150" className={inputCls} />
          </Field>

          <Field label="月營收年增下限 (%)">
            <input type="number" step="any" name="revMYoyMin" defaultValue={f.revMYoyMin ?? ''}
              placeholder="例：20" className={inputCls} />
          </Field>

          <Field label="預估EPS 下限（自算）">
            <input type="number" step="any" name="estEpsMin" defaultValue={f.estEpsMin ?? ''}
              placeholder="例：5" className={inputCls} />
          </Field>

          <Field label="ROA 年化下限 (%)">
            <input type="number" step="any" name="roaMin" defaultValue={f.roaMin ?? ''}
              placeholder="例：8" className={inputCls} />
          </Field>

          <Field label="董監持股下限 (%)">
            <input type="number" step="any" name="dirMin" defaultValue={f.dirMin ?? ''}
              placeholder="例：20" className={inputCls} />
          </Field>

          <Field label="董監設質上限 (%)">
            <input type="number" step="any" name="pledgeMax" defaultValue={f.pledgeMax ?? ''}
              placeholder="例：10" className={inputCls} />
          </Field>

          <Field label="股價 ÷ 便宜價 上限">
            <input type="number" step="any" name="cheapRatioMax" defaultValue={f.cheapRatioMax ?? ''}
              placeholder="1 = 股價低於便宜價" className={inputCls} />
          </Field>

          <Field label="負債比上限 (%)">
            <input
              type="number"
              step="any"
              name="debtMax"
              defaultValue={f.debtMax ?? ''}
              placeholder="例：60"
              className={inputCls}
            />
          </Field>

          <Field label="成交量下限 (張)">
            <input
              type="number"
              name="volMin"
              defaultValue={f.volMin ?? ''}
              placeholder="例：500"
              className={inputCls}
            />
          </Field>

          <Field label="市場">
            <div className="flex flex-wrap items-center gap-3 pt-1 text-sm">
              {Object.entries(MARKET_LABEL).map(([value, label]) => (
                <label key={value} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    name="market"
                    value={value}
                    defaultChecked={f.markets.includes(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </Field>

          <Field label="每頁筆數">
            <select name="size" defaultValue={String(f.size)} className={inputCls}>
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* 送出表單時把目前的排序帶著走，不然一按篩選排序就被重設 */}
        <input type="hidden" name="sort" value={f.sort} />
        <input type="hidden" name="dir" value={f.dir} />

        <div className="mt-3 flex items-center gap-2">
          <button
            type="submit"
            className="rounded bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            篩選
          </button>
          <Link
            href="/"
            className="rounded border border-zinc-300 px-4 py-1.5 text-sm dark:border-zinc-700"
          >
            清除
          </Link>
          {result && result.total > 0 && (
            <a
              href={`/api/export?${withParams(params, ['page', 'size'])}`}
              className="rounded border border-zinc-300 px-4 py-1.5 text-sm dark:border-zinc-700"
            >
              下載 CSV
            </a>
          )}
        </div>
      </form>

      {!result ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
          資料庫裡還沒有任何行情資料。先執行{' '}
          <code className="font-mono">npm run sync -- --commit</code>。
        </p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm text-zinc-500">
            <span>
              基準日{' '}
              <strong className="text-zinc-900 dark:text-zinc-100">{result.tradeDate}</strong>
              ，符合{' '}
              <strong className="text-zinc-900 dark:text-zinc-100">
                {result.total.toLocaleString('zh-TW')}
              </strong>{' '}
              檔
            </span>
            {result.pageCount > 1 && (
              <span>
                第 {result.page} / {result.pageCount} 頁
              </span>
            )}
          </div>

          {period?.quarterEnd && (
            <div className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-6 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              <strong className="text-zinc-900 dark:text-zinc-100">這個基準日對應的實際期間</strong>
              <br />
              財報期別 <strong>{period.quarterEnd}</strong>（第 {period.quarter} 季）
              ｜ 單季 <strong>{quarterStart(period.quarterEnd)} ~ {period.quarterEnd}</strong>（3 個月）
              ｜ 累計 <strong>{period.quarterEnd.slice(0, 4)}-01-01 ~ {period.quarterEnd}</strong>（{ytdMonths} 個月）
              ｜ 近四季 <strong>{ttmStart(period.quarterEnd)} ~ {period.quarterEnd}</strong>（12 個月）
              <br />
              近12月 <strong>{ttmDayStart(result.tradeDate)} ~ {result.tradeDate}</strong>
              ｜ 5年 <strong>{Number(result.tradeDate.slice(0, 4)) - 5}-01-01 ~ {Number(result.tradeDate.slice(0, 4)) - 1}-12-31</strong>
              ｜ 10年 <strong>{Number(result.tradeDate.slice(0, 4)) - 10}-01-01 ~ {Number(result.tradeDate.slice(0, 4)) - 1}-12-31</strong>
              {period.capitalDate && <> ｜ 股本公告日 <strong>{period.capitalDate}</strong></>}
              {period.insiderDate && <> ｜ 內部人持股 <strong>{period.insiderDate}</strong></>}
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[5800px] text-sm">
              <thead className="bg-zinc-50 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.label}
                      className={`px-2 py-2 font-medium ${c.right ? 'text-right' : 'text-left'}`}
                    >
                      {c.key ? (
                        <Link href={sortHref(params, f, c.key)} className="hover:underline">
                          {c.label}
                          {f.sort === c.key && (f.dir === 'desc' ? ' ▼' : ' ▲')}
                        </Link>
                      ) : (
                        c.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <Row key={r.stock_id} r={r} />
                ))}
              </tbody>
            </table>
          </div>

          {result.rows.length === 0 && (
            <p className="mt-4 text-sm text-zinc-500">沒有符合條件的股票，放寬一點試試。</p>
          )}

          {result.pageCount > 1 && (
            <nav className="mt-4 flex items-center gap-2 text-sm">
              {result.page > 1 && (
                <Link
                  href={`/?${withParams(params, ['page'], { page: String(result.page - 1) })}`}
                  className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700"
                >
                  上一頁
                </Link>
              )}
              {result.page < result.pageCount && (
                <Link
                  href={`/?${withParams(params, ['page'], { page: String(result.page + 1) })}`}
                  className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700"
                >
                  下一頁
                </Link>
              )}
            </nav>
          )}

          <p className="mt-6 text-xs text-zinc-400">
            興櫃沒有集中撮合，交易所不公告本益比與殖利率，那幾欄會是空的；ETF 同理沒有股本與財報。
            銀行業沒有單一「營業收入」，毛利率一類自然算不出來。
            <br />
            殖利率有兩欄：「殖利率」是交易所公告值（<strong>不含 ETF</strong>，除息後還有更新延遲）；
            「年化殖利率」是我們用逐筆配息紀錄自己算的近 12 個月合計，ETF 也有。
            5年／10年<strong>均殖</strong> = 近 N 個完整年度的平均現金股利 ÷ <strong>基準日</strong>收盤價，
            問的是「用今天的價格買，領過去的平均股利有多少報酬」。
            5年／10年<strong>歷史殖</strong> = 每年股利 ÷ <strong>當年均價</strong>再平均，
            問的是「過去這幾年買的人平均領到多少」。那一年沒配息就算 0%。
            <br />
            <strong>預估EPS 是自己算的，不是法人估。</strong>法人預估沒有免費來源，
            所以改用官方每月公告的月營收推估：已公布月份用實際值，剩餘月份用
            「去年同期 × 今年累計成長率」補完，再乘上淨利率、除以股數。
            基準版的淨利率用近四季；保守版假設剩餘月份零成長、淨利率取近八季單季最低。
            全年 12 個月都公布時，預估值會自動收斂成實際值。
            算式公開，而且月營收有十年歷史，這個推估法準不準是可以回測的。
            <br />
            <strong>便宜價</strong>三欄的假設不同：股利法＝近5年平均股利 ÷ 5%；
            本益比法＝年化EPS × 近5年最低本益比；淨值法＝每股淨值 × 近5年最低股價淨值比。
            「股價÷便宜價」篩選取三者中<strong>最寬鬆</strong>的一個當門檻——
            三種假設本來就不會同時成立，取最嚴的幾乎篩不到東西。
            <br />
            <strong>董監／經理人／大股東持股</strong>來自公開申報的逐人明細，
            同一人兼多職會重複列示，寫入前已依姓名去重。三者會互相重疊
            （法人大股東常同時是董事），這是定義使然不是重複計算。
            設質比例的分母是董監自己的持股，不是總股數。
            <br />
            財報是<strong>累計數</strong>：EPS 與各項比率的分子都是年初至該季，
            ROE 已乘以 4/季別年化以便比較。財報只取交易日之前已公告的期別，不會用到未來資料。
          </p>
        </>
      )}
    </div>
  );
}
