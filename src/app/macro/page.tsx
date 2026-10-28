import Link from 'next/link';
import MacroExportPanel from '@/components/MacroExportPanel';
import type { MacroThemeResult, Tone } from '@/lib/macro';
import { CATEGORIES, HORIZONS, type Category } from '@/lib/macro-rules';
import {
  EFFECT_LABEL,
  TONE_HINT,
  TONE_LABEL,
  formatBytes,
  listReports,
  newsById,
  otherNews,
  shortTime,
  storageStats,
  themeCounts,
  type StoredReport,
} from '@/lib/macro-store';

export const dynamic = 'force-dynamic';

/** 一頁幾天。一份報告的主題與新聞就有好幾屏，一次給太多天反而找不到東西 */
const PAGE = 7;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 台股習慣：紅色利多、綠色利空，跟歐美相反（與即時報價頁一致） */
function effectTone(e: Tone) {
  if (e === 1) return 'text-red-600 dark:text-red-400';
  if (e === -1) return 'text-green-700 dark:text-green-400';
  return 'text-zinc-500';
}

function toneBadge(t: Tone) {
  if (t === 1) return 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900';
  if (t === -1) return 'bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100';
  return 'border border-dashed border-zinc-400 text-zinc-500';
}

interface Tally {
  name: string;
  up: number;
  down: number;
  unclear: number;
}

/** 這幾天各個股被點名的次數（同一天同一檔被多個主題點名就算多次） */
function tallyStocks(reports: StoredReport[], keep: (t: MacroThemeResult) => boolean) {
  const tally = new Map<string, Tally>();
  for (const r of reports) {
    for (const t of r.payload.themes.filter(keep)) {
      for (const i of t.impacts) {
        const row = tally.get(i.stockId) ?? { name: i.stockName, up: 0, down: 0, unclear: 0 };
        if (i.effect === 1) row.up += 1;
        else if (i.effect === -1) row.down += 1;
        else row.unclear += 1;
        tally.set(i.stockId, row);
      }
    }
  }
  return [...tally.entries()]
    .sort(([, a], [, b]) => b.up + b.down + b.unclear - (a.up + a.down + a.unclear))
    .slice(0, 15);
}

function ThemeCard({ t, report }: { t: MacroThemeResult; report: StoredReport }) {
  const byId = newsById(report.payload);
  const more = t.newsCount - t.newsIds.length;
  const indicators = t.indicatorKeys
    .map((k) => report.payload.indicators.find((i) => i.key === k))
    .filter((i) => i !== undefined);

  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{t.label}</h3>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {CATEGORIES[t.category]}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-xs ${toneBadge(t.tone)}`}>整體{TONE_LABEL[t.tone]}</span>
        <span className="text-xs text-zinc-400">{themeCounts(t)}</span>
      </div>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{t.summary}</p>
      {indicators.length > 0 && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-500">
          指標觸發：{indicators.map((i) => `${i.label} ${i.value}（${i.change}）`).join('；')}
        </p>
      )}
      {TONE_HINT[t.tone] && <p className="mt-1 text-xs text-zinc-500">{TONE_HINT[t.tone]}</p>}

      {t.impacts.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                {['股號', '股名', '影響', '週期', '理由'].map((h) => (
                  <th key={h} className="px-1.5 py-1 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.impacts.map((i) => (
                <tr key={i.stockId} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-1.5 py-1 font-mono">
                    <Link href={`/stock/${i.stockId}`} className="text-sky-700 hover:underline dark:text-sky-400">
                      {i.stockId}
                    </Link>
                  </td>
                  <td className="px-1.5 py-1 whitespace-nowrap">
                    <Link href={`/stock/${i.stockId}`} className="text-sky-700 hover:underline dark:text-sky-400">
                      {i.stockName}
                    </Link>
                  </td>
                  <td className={`px-1.5 py-1 font-medium whitespace-nowrap ${effectTone(i.effect)}`}>
                    {EFFECT_LABEL[i.effect]}
                  </td>
                  <td className="px-1.5 py-1 whitespace-nowrap text-zinc-600 dark:text-zinc-300">
                    {HORIZONS[i.horizon].label}
                    <span className="text-xs text-zinc-400">（{HORIZONS[i.horizon].range}）</span>
                  </td>
                  <td className="px-1.5 py-1 text-zinc-600 dark:text-zinc-300">{i.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {t.newsIds.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {t.newsIds.map((id) => {
            const n = byId.get(id);
            if (!n) return null;
            const tone = n.hits.find((h) => h.theme === t.id)?.tone ?? 0;
            return (
              <li key={id} className="flex gap-1.5">
                <span className={`shrink-0 text-xs leading-5 ${effectTone(tone)}`} title={TONE_LABEL[tone]}>
                  {tone === 1 ? '▲' : tone === -1 ? '▼' : '・'}
                </span>
                <span>
                  <a href={n.link} target="_blank" rel="noopener noreferrer" className="hover:underline">
                    {n.title}
                  </a>{' '}
                  <span className="text-xs text-zinc-400">
                    {n.source}・{shortTime(n.publishedAt)}
                  </span>
                </span>
              </li>
            );
          })}
          {more > 0 && <li className="text-xs text-zinc-400">另有 {more} 則同主題新聞沒有保留，只計入上面的則數。</li>}
        </ul>
      )}
    </div>
  );
}

export default async function MacroPage({ searchParams }: PageProps<'/macro'>) {
  const params = (await searchParams) as Record<string, string | string[] | undefined>;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const catParam = one(params.cat);
  const cat = catParam in CATEGORIES ? (catParam as Category) : null;
  const stock = one(params.stock).trim();
  const before = DATE.test(one(params.before)) ? one(params.before) : undefined;

  const [reports, stats] = await Promise.all([listReports(PAGE, before), storageStats()]);
  const canDelete = Boolean(process.env.MACRO_ADMIN_PASSWORD);

  const keep = (t: MacroThemeResult) =>
    (!cat || t.category === cat) && (!stock || t.impacts.some((i) => i.stockId === stock));
  const tally = tallyStocks(reports, keep);
  const nextBefore = reports.length === PAGE ? reports[reports.length - 1].reportDate : null;
  const filtered = Boolean(cat || stock);
  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (cat) p.set('cat', cat);
    if (stock) p.set('stock', stock);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-4 sm:py-6">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">宏觀事件預覽</h1>
        <p className="mt-1 text-sm text-zinc-500">
          每天整理美國與台灣的政策、產業動態、國際資金、戰爭地緣與能源新聞，列出這類消息通常會牽動的台股與影響週期。
          新聞來自 Google 新聞、Fed、EIA、Yahoo 股市的 RSS，指標來自 FinMind。
        </p>
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          這是<strong>關鍵字規則比對</strong>，不是 AI 判讀，也不是投資建議：標題對到預先寫好的主題，
          再列出該主題<strong>一般情況下</strong>會影響的個股。只看標題、看不到內文；同一檔可能同時被不同主題點名、方向相反，要合起來看。
          <span className="text-red-600 dark:text-red-400">紅色＝利多</span>、
          <span className="text-green-700 dark:text-green-400">綠色＝利空</span>，灰色「看新聞」是當天正反消息抵銷或看不出方向。
        </p>
      </header>

      <MacroExportPanel
        count={stats.count}
        from={stats.from}
        to={stats.to}
        size={formatBytes(stats.bytes)}
        canDelete={canDelete}
      />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          類別
          <select
            name="cat"
            defaultValue={cat ?? ''}
            className="rounded border border-zinc-300 bg-white px-2 py-2 text-sm sm:py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">全部</option>
            {Object.entries(CATEGORIES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          只看影響某檔股票
          <input
            name="stock"
            defaultValue={stock}
            placeholder="股號，例如 2330"
            inputMode="numeric"
            className="w-36 rounded border border-zinc-300 bg-white px-2 py-2 text-sm sm:py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <button
          type="submit"
          className="rounded bg-zinc-900 px-4 py-2.5 text-sm text-white sm:py-2 dark:bg-zinc-100 dark:text-zinc-900"
        >
          篩選
        </button>
        {filtered && (
          <Link href="/macro" className="px-2 py-2 text-sm text-sky-700 hover:underline dark:text-sky-400">
            清除條件
          </Link>
        )}
      </form>

      {reports.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {before ? '這之前沒有更早的報告了。' : '還沒有報告。'}
          <br />
          <span className="text-xs text-zinc-400">
            每天台北清晨與上午各自動產生一次；也可以到 GitHub Actions 手動執行「宏觀事件預覽」。
          </span>
        </p>
      ) : (
        <>
          {tally.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-semibold text-zinc-600 dark:text-zinc-300">
                這 {reports.length} 天被點名最多的個股
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {tally.map(([id, t]) => (
                  <Link
                    key={id}
                    href={`/macro${qs({ stock: id })}`}
                    className="rounded border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                    title="只看影響這檔的主題"
                  >
                    <span className="font-mono">{id}</span> {t.name}{' '}
                    {t.up > 0 && <span className={effectTone(1)}>▲{t.up}</span>}{' '}
                    {t.down > 0 && <span className={effectTone(-1)}>▼{t.down}</span>}{' '}
                    {t.unclear > 0 && <span className="text-zinc-400">・{t.unclear}</span>}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {reports.map((r) => {
            const themes = r.payload.themes.filter(keep);
            const others = filtered ? [] : otherNews(r.payload);
            const failed = r.payload.sources.filter((s) => !s.ok);
            return (
              <section key={r.reportDate} className="mb-8">
                <div className="sticky top-[49px] z-20 -mx-3 mb-2 border-b border-zinc-200 bg-white/95 px-3 py-2 backdrop-blur sm:-mx-4 sm:px-4 dark:border-zinc-800 dark:bg-zinc-950/95">
                  <h2 className="text-lg font-semibold">{r.reportDate}</h2>
                  <p className="text-xs text-zinc-400">
                    產生於 {r.generatedAt}・新聞期間 {shortTime(r.payload.windowFrom)} ～ {shortTime(r.payload.windowTo)}・
                    {r.payload.stats.unique} 則中 {r.payload.stats.matched} 則對到主題
                    {failed.length > 0 && `・${failed.length} 個來源沒抓到`}
                  </p>
                </div>

                <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
                  {r.payload.indicators.map((i) => (
                    <div
                      key={i.key}
                      className={`rounded border px-2 py-1.5 text-xs ${
                        i.trigger
                          ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40'
                          : 'border-zinc-200 dark:border-zinc-800'
                      }`}
                    >
                      <div className="text-zinc-500">{i.label}</div>
                      <div className="text-sm font-medium tabular-nums">{i.value}</div>
                      <div className="text-zinc-500">{i.change}</div>
                      <div className={i.stale ? 'text-amber-700 dark:text-amber-500' : 'text-zinc-400'}>{i.note}</div>
                    </div>
                  ))}
                </div>

                {themes.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    {filtered ? '這天沒有符合篩選條件的主題。' : '這天沒有新聞對到任何主題。'}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {themes.map((t) => (
                      <ThemeCard key={t.id} t={t} report={r} />
                    ))}
                  </div>
                )}

                {others.length > 0 && (
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer text-zinc-500">其他新聞（沒有對到主題）</summary>
                    {others.map(([label, list]) => (
                      <div key={label} className="mt-2">
                        <h4 className="text-xs font-semibold text-zinc-500">{label}</h4>
                        <ul className="mt-1 space-y-1">
                          {list.map((n) => (
                            <li key={n.id}>
                              <a href={n.link} target="_blank" rel="noopener noreferrer" className="hover:underline">
                                {n.title}
                              </a>{' '}
                              <span className="text-xs text-zinc-400">{n.source}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </details>
                )}
              </section>
            );
          })}

          <nav className="flex flex-wrap justify-between gap-2 text-sm">
            {before ? (
              <Link href={`/macro${qs({})}`} className="text-sky-700 hover:underline dark:text-sky-400">
                ← 回到最新
              </Link>
            ) : (
              <span />
            )}
            {nextBefore && (
              <Link
                href={`/macro${qs({ before: nextBefore })}`}
                className="text-sky-700 hover:underline dark:text-sky-400"
              >
                更早的報告 →
              </Link>
            )}
          </nav>
        </>
      )}

      <p className="mt-8 text-xs text-zinc-400">
        主題、關鍵字、個股與週期的對照表寫在 <code className="font-mono">src/lib/macro-rules.ts</code>；
        產生報告時會拿股票主檔核對股號與股名，對不上的直接略過，不會掛到別家公司頭上。
      </p>
    </div>
  );
}
