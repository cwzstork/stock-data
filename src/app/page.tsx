import Link from 'next/link';
import {
  MARKET_LABEL,
  PAGE_SIZES,
  getIndustries,
  getTradeDates,
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

const COLUMNS: { key: SortKey | null; label: string; right?: boolean }[] = [
  { key: 'stock_id', label: '股號' },
  { key: null, label: '股名' },
  { key: null, label: '市場' },
  { key: null, label: '產業' },
  { key: 'close', label: '收盤', right: true },
  { key: 'volume', label: '成交量(張)', right: true },
  { key: 'turnover', label: '成交額(千元)', right: true },
  { key: 'dividend_yield', label: '殖利率(%)', right: true },
  { key: 'per', label: '本益比', right: true },
  { key: 'pbr', label: '淨值比', right: true },
  { key: 'capital', label: '股本(百萬)', right: true },
  { key: 'gross_margin', label: '毛利率(%)', right: true },
  { key: 'op_margin', label: '營益率(%)', right: true },
  { key: 'net_margin', label: '淨利率(%)', right: true },
  { key: 'roe', label: 'ROE(%)', right: true },
  { key: 'debt_ratio', label: '負債比(%)', right: true },
  { key: 'eps', label: 'EPS', right: true },
  { key: 'bvps', label: '每股淨值', right: true },
  { key: null, label: '財報期別' },
];

function Row({ r }: { r: ScreenerRow }) {
  return (
    <tr className="border-b border-zinc-100 hover:bg-amber-50/60 dark:border-zinc-800 dark:hover:bg-zinc-800/60">
      <td className="px-2 py-1 font-mono">{r.stock_id}</td>
      <td className="px-2 py-1 whitespace-nowrap">{r.stock_name}</td>
      <td className="px-2 py-1 whitespace-nowrap text-zinc-500">
        {MARKET_LABEL[r.market] ?? r.market}
      </td>
      <td className="px-2 py-1 whitespace-nowrap text-zinc-500">{r.industry_category ?? dash}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmt(r.close, 2)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{lots(r.volume)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{scaled(r.turnover, 1000)}</td>
      <td className="px-2 py-1 text-right tabular-nums font-medium">{fmt(r.dividend_yield, 2)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmt(r.per, 2)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmt(r.pbr, 2)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{scaled(r.capital, 1e6)}</td>
      <td className="px-2 py-1 text-right tabular-nums font-medium">{fmt(r.gross_margin, 2)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmt(r.op_margin, 2)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmt(r.net_margin, 2)}</td>
      <td className="px-2 py-1 text-right tabular-nums font-medium">{fmt(r.roe, 2)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmt(r.debt_ratio, 2)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmt(r.eps, 2)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{fmt(r.bvps, 2)}</td>
      <td className="px-2 py-1 whitespace-nowrap text-zinc-500">{r.period_end ?? dash}</td>
    </tr>
  );
}

// ── 頁面 ──────────────────────────────────────────────────────────

export default async function Home({ searchParams }: PageProps<'/'>) {
  const params = (await searchParams) as RawParams;
  const f = parseFilters(params);

  // 交易日清單只查一次：下拉選單要用，runScreener 決定基準日也要用
  const dates = await getTradeDates();
  const [result, industries] = await Promise.all([runScreener(f, dates), getIndustries()]);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-6">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">台股篩選器</h1>
        <p className="mt-1 text-sm text-zinc-500">
          條件都在網址裡，可以加書籤或分享——每次打開都是用當下的資料重跑一次，不會拿到過期的清單。
        </p>
      </header>

      <form method="get" className="mb-5 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="基準日">
            <select name="date" defaultValue={result?.tradeDate ?? ''} className={inputCls}>
              {dates.map((d) => (
                <option key={d} value={d}>
                  {d}
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

          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[1700px] text-sm">
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
            財報是<strong>累計數</strong>：EPS 與各項比率的分子都是年初至該季，
            ROE 已乘以 4/季別年化以便比較。財報只取交易日之前已公告的期別，不會用到未來資料。
          </p>
        </>
      )}
    </div>
  );
}
