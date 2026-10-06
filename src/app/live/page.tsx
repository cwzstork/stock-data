import Link from 'next/link';
import StockPicker from '@/components/StockPicker';
import { fetchLiveQuotes, type LiveQuote } from '@/lib/live';
import { MARKET_LABEL } from '@/lib/screener';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** 一次查太多會拖慢頁面，也對證交所不禮貌 */
const MAX = 60;

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

interface Matched {
  stock_id: string;
  stock_name: string;
  market: string;
  /** 是被哪個關鍵字找到的，用來回報哪些字沒找到東西 */
  term: string;
  rank: number;
}

/**
 * 把使用者輸入的關鍵字解析成股票。
 *
 * 一個關鍵字可以是股號（2330）、股號開頭（233）、或股名的一部分（台積、高股息）。
 * 中文名稱用 ILIKE 做包含比對——台股股名很短，前綴比對會漏掉
 * 「元大高股息」這種要用中間字找的情況。
 *
 * 排序刻意分三級：完全等於股號的一定排最前面，否則搜「2330」時
 * 會被一堆股名含「2330」的雜訊蓋過（雖然少見，但排序要可預期）。
 */
async function resolveFuzzy(terms: string[]): Promise<Matched[]> {
  if (terms.length === 0) return [];
  return prisma.$queryRawUnsafe<Matched[]>(
    `SELECT DISTINCT ON (s.stock_id)
            s.stock_id, s.stock_name, s.market, t.term,
            CASE WHEN s.stock_id = t.term THEN 0
                 WHEN s.stock_id LIKE t.term || '%' THEN 1
                 WHEN s.stock_name ILIKE t.term || '%' THEN 2
                 ELSE 3 END AS rank
       FROM stock s
       JOIN unnest($1::text[]) AS t(term)
         ON s.stock_id = t.term
         OR s.stock_id LIKE t.term || '%'
         OR s.stock_name ILIKE '%' || t.term || '%'
      ORDER BY s.stock_id, rank`,
    terms,
  );
}

/**
 * 從多選器送來的是明確選取的股號，一定要用完全相等比對。
 *
 * 不能重用模糊比對：選了 2881 富邦金，前綴比對會把 2881A / 2881B / 2881C
 * 這些特別股一起拉進來，使用者明明只點了一檔卻跑出四檔。
 */
async function resolveExact(ids: string[]): Promise<Matched[]> {
  if (ids.length === 0) return [];
  return prisma.$queryRawUnsafe<Matched[]>(
    `SELECT s.stock_id, s.stock_name, s.market, s.stock_id AS term, 0 AS rank
       FROM stock s
      WHERE s.stock_id = ANY($1::text[])
      ORDER BY s.stock_id`,
    ids,
  );
}

export default async function LivePage({ searchParams }: PageProps<'/live'>) {
  const params = (await searchParams) as Record<string, string | string[] | undefined>;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  // ids 是多選器送出的明確選取；q 是直接打在網址上的自由文字，保留給分享連結用
  const idsParam = one(params.ids);
  const qParam = one(params.q);
  // 預設是空的——自選清單沒有「合理的預設」，隨便塞幾檔進去
  // 只會讓人每次都要先刪掉
  const raw = qParam ?? idsParam ?? '';

  // 逗號、全形逗號、頓號、空白都當分隔
  const terms = [...new Set(raw.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean))];

  const matched =
    qParam === undefined && idsParam !== undefined
      ? await resolveExact(terms)
      : await resolveFuzzy(terms);
  // rank 小的優先，同 rank 依股號；超過上限就截斷並提示
  matched.sort((a, b) => a.rank - b.rank || a.stock_id.localeCompare(b.stock_id));
  const picked = matched.slice(0, MAX);
  const truncated = matched.length - picked.length;

  const hitTerms = new Set(matched.map((m) => m.term));
  const missTerms = terms.filter((t) => !hitTerms.has(t));
  const empty = terms.length === 0;

  const nameOf = new Map(picked.map((m) => [m.stock_id, m.stock_name]));
  const marketOf = new Map(picked.map((m) => [m.stock_id, m.market]));

  let quotes: LiveQuote[] = [];
  let error: string | null = null;
  if (picked.length > 0) {
    try {
      quotes = await fetchLiveQuotes(picked.map((m) => ({ stockId: m.stock_id, market: m.market })));
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

      <form method="get" className="mb-2 flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <StockPicker name="ids" initial={picked} max={MAX} />
        </div>
        <button
          type="submit"
          className="rounded bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          查詢
        </button>
      </form>
      <p className="mb-4 text-xs text-zinc-400">
        打中文的一部分就會跳候選：<strong>台</strong> → 台泥、台積電、台光電…，點一下加入。
        股號也可以（打 <strong>233</strong> 或 <strong>00878</strong>）。
        ↑↓ 選、Enter 加入、輸入框空的時候按倒退鍵移除最後一個。最多 {MAX} 檔。
      </p>

      {empty && (
        <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          上面輸入股名或股號，選好之後按「查詢」。
          <br />
          <span className="text-xs text-zinc-400">
            選好的清單會留在網址上，可以加書籤或分享。
          </span>
        </p>
      )}

      {error && (
        <p className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-950">
          {error}
        </p>
      )}
      {missTerms.length > 0 && (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-500">
          找不到符合的股票：{missTerms.join('、')}
        </p>
      )}
      {truncated > 0 && (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-500">
          共找到 {matched.length} 檔，只顯示前 {MAX} 檔。關鍵字再精確一點可以少一些。
        </p>
      )}

      {quotes.length > 0 && (
        <>
          <p className="mb-2 text-sm text-zinc-500">
            {asOfDate} {asOf} 報價，共 {quotes.length} 檔
          </p>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[860px] text-sm">
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
                    {/* 點股號或股名進個股線圖 */}
                    <td className="px-2 py-1 font-mono">
                      <Link href={`/stock/${q.stockId}`} className="text-sky-700 hover:underline dark:text-sky-400">
                        {q.stockId}
                      </Link>
                    </td>
                    {/* MIS 回傳的名稱偶爾是簡稱或空白，主檔的比較一致 */}
                    <td className="px-2 py-1 whitespace-nowrap">
                      <Link href={`/stock/${q.stockId}`} className="text-sky-700 hover:underline dark:text-sky-400">
                        {nameOf.get(q.stockId) ?? q.name}
                      </Link>
                    </td>
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
