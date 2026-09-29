import Link from 'next/link';
import { fetchLiveQuotes, type LiveQuote } from '@/lib/live';
import { MARKET_LABEL } from '@/lib/screener';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** 一次查太多會拖慢頁面，也對證交所不禮貌 */
const MAX = 60;
const DEFAULT_LIST = '2330,2317,2454,2412,2881,0050,0056,00878';

const dash = <span className="text-zinc-400 dark:text-zinc-600">—</span>;

function fmt(v: number | null, digits = 2) {
  if (v === null) return dash;
  return v.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 台股習慣：漲紅跌綠，跟歐美相反 */
function toneOf(v: number | null) {
  if (v === null || v === 0) return 'text-zinc-500';
  return v > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400';
}

const SOURCE_LABEL: Record<LiveQuote['priceSource'], string> = {
  trade: '成交',
  bid: '委買',
  prevClose: '昨收',
};

export default async function LivePage({ searchParams }: PageProps<'/live'>) {
  const params = (await searchParams) as Record<string, string | string[] | undefined>;
  const raw = (Array.isArray(params.ids) ? params.ids[0] : params.ids) ?? DEFAULT_LIST;

  const ids = [...new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))].slice(0, MAX);

  // market 決定 MIS 的頻道前綴（tse / otc），弄錯就查不到
  const known = await prisma.$queryRawUnsafe<{ stock_id: string; market: string }[]>(
    `SELECT stock_id, market FROM stock WHERE stock_id = ANY($1::text[])`,
    ids,
  );
  const marketOf = new Map(known.map((k) => [k.stock_id, k.market]));
  const missing = ids.filter((id) => !marketOf.has(id));

  let quotes: LiveQuote[] = [];
  let error: string | null = null;
  if (marketOf.size > 0) {
    try {
      quotes = await fetchLiveQuotes(
        ids.filter((id) => marketOf.has(id)).map((id) => ({ stockId: id, market: marketOf.get(id)! })),
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const asOf = quotes.find((q) => q.time)?.time ?? '';
  const asOfDate = quotes.find((q) => q.date)?.date ?? '';

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">即時報價</h1>
          <p className="mt-1 text-sm text-zinc-500">
            證交所 MIS，約延遲 20 秒。這頁的資料<strong>不會寫進資料庫</strong>——
            <code className="font-mono text-xs">stock_daily</code> 的語意是當日收盤，
            混入盤中價會讓歷史資料失去意義。
          </p>
        </div>
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          ← 回篩選器
        </Link>
      </header>

      <form method="get" className="mb-4 flex flex-wrap items-center gap-2">
        <input
          name="ids"
          defaultValue={raw}
          placeholder="股號，逗號或空白分隔"
          className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          className="rounded bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          查詢
        </button>
        <span className="text-xs text-zinc-400">最多 {MAX} 檔</span>
      </form>

      {error && (
        <p className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-950">
          {error}
        </p>
      )}
      {missing.length > 0 && (
        <p className="mb-4 text-sm text-amber-700 dark:text-amber-500">
          主檔裡沒有這些代號，已略過：{missing.join('、')}
        </p>
      )}

      {quotes.length > 0 && (
        <>
          <p className="mb-2 text-sm text-zinc-500">
            {asOfDate} {asOf} 報價
          </p>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-zinc-50 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  {['股號', '股名', '市場', '價格', '來源', '漲跌', '漲跌幅', '開', '高', '低', '昨收', '量(張)'].map(
                    (h, i) => (
                      <th key={h} className={`px-2 py-2 font-medium ${i >= 3 ? 'text-right' : 'text-left'}`}>
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => (
                  <tr
                    key={q.stockId}
                    className="border-b border-zinc-100 hover:bg-amber-50/60 dark:border-zinc-800 dark:hover:bg-zinc-800/60"
                  >
                    <td className="px-2 py-1 font-mono">{q.stockId}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{q.name}</td>
                    <td className="px-2 py-1 text-zinc-500">
                      {MARKET_LABEL[marketOf.get(q.stockId) ?? ''] ?? ''}
                    </td>
                    <td className={`px-2 py-1 text-right tabular-nums font-medium ${toneOf(q.change)}`}>
                      {fmt(q.price)}
                    </td>
                    <td className="px-2 py-1 text-right text-xs text-zinc-400">
                      {SOURCE_LABEL[q.priceSource]}
                    </td>
                    <td className={`px-2 py-1 text-right tabular-nums ${toneOf(q.change)}`}>
                      {q.change === null ? dash : `${q.change > 0 ? '+' : ''}${fmt(q.change)}`}
                    </td>
                    <td className={`px-2 py-1 text-right tabular-nums ${toneOf(q.change)}`}>
                      {q.changePct === null ? dash : `${q.changePct > 0 ? '+' : ''}${fmt(q.changePct)}%`}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmt(q.open)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmt(q.high)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmt(q.low)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-zinc-500">{fmt(q.prevClose)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmt(q.volume, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-xs text-zinc-400">
            「來源」欄說明價格怎麼來的：<strong>成交</strong>是該瞬間真的有撮合；
            <strong>委買</strong>是當下沒成交，退回最佳委買價；<strong>昨收</strong>是連委買都沒有
            （停牌或尚未開盤）。冷門股在盤中常常沒有即時成交，這很正常。
            <br />
            非交易時段查到的是最後一次收盤後的靜態資料。
          </p>
        </>
      )}
    </div>
  );
}
