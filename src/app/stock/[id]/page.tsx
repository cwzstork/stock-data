import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { fetchLiveQuotes } from '@/lib/live';
import { fetchBars, withIndicators, sliceRange, RANGES, isRangeKey, type RangeKey } from '@/lib/history';
import { MARKET_LABEL } from '@/lib/screener';
import StockChart from '@/components/StockChart';

export const dynamic = 'force-dynamic';

/** 指標要用完整歷史算才準（60 日線需要前 60 根），所以一律抓十年再裁切 */
const START_DATE = '2015-01-01';

interface Row {
  stock_id: string;
  stock_name: string;
  market: string;
  industry_category: string | null;
}

const fmt = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d);

export default async function StockPage({
  params,
  searchParams,
}: PageProps<'/stock/[id]'>) {
  const { id } = await params;
  const sp = await searchParams;
  const rangeRaw = typeof sp.range === 'string' ? sp.range : null;
  const range: RangeKey = isRangeKey(rangeRaw) ? rangeRaw : '1y';

  const [stock] = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT stock_id, stock_name, market, industry_category FROM stock WHERE stock_id = $1`,
    id,
  );
  if (!stock) notFound();

  // 線圖資料與即時報價互不相干，一起等就好
  const [bars, quotes] = await Promise.all([
    fetchBars(id, START_DATE).catch(() => []),
    fetchLiveQuotes([{ stockId: id, market: stock.market }]).catch(() => []),
  ]);
  const live = quotes[0];
  const points = sliceRange(withIndicators(bars), range);
  const last = points[points.length - 1];

  const keep = (r: RangeKey) => `/stock/${id}?range=${r}`;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href="/live" className="text-sm text-zinc-500 hover:underline">
          ← 即時報價
        </Link>
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          台股篩選器
        </Link>
      </div>

      <h1 className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-mono text-2xl text-zinc-500">{stock.stock_id}</span>
        <span className="text-2xl font-bold">{stock.stock_name}</span>
        <span className="text-sm text-zinc-500">
          {MARKET_LABEL[stock.market] ?? stock.market}
          {stock.industry_category ? ` · ${stock.industry_category}` : ''}
        </span>
      </h1>

      {live && (
        <p className="mt-1 text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
          即時 <b className="text-base">{fmt(live.price)}</b>
          {live.change !== null && (
            <span className={live.change >= 0 ? 'ml-2 text-red-600' : 'ml-2 text-green-600'}>
              {live.change >= 0 ? '+' : ''}
              {fmt(live.change)}（{fmt(live.changePct)}%）
            </span>
          )}
          <span className="ml-3 text-xs text-zinc-500">{live.time ?? ''}　約延遲 20 秒</span>
        </p>
      )}

      <div className="my-4 flex flex-wrap gap-1">
        {(Object.keys(RANGES) as RangeKey[]).map((r) => (
          <Link
            key={r}
            href={keep(r)}
            className={`rounded px-3 py-1 text-sm transition ${
              r === range
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
            }`}
          >
            {RANGES[r].label}
          </Link>
        ))}
      </div>

      <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <StockChart points={points} />
      </div>

      {last && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card title="布林通道（20日,2倍標準差）">
            <Line k="上軌" v={fmt(last.bbUpper)} />
            <Line k="中軌（MA20）" v={fmt(last.ma20)} />
            <Line k="下軌" v={fmt(last.bbLower)} />
            <Line
              k="位置"
              v={
                last.bbUpper !== null && last.bbLower !== null && last.bbUpper > last.bbLower
                  ? `${fmt(((last.close - last.bbLower) / (last.bbUpper - last.bbLower)) * 100, 0)}%`
                  : '—'
              }
            />
          </Card>
          <Card title="主力成本（成交金額÷成交股數）">
            <Line k="近 20 日" v={fmt(last.cost20)} />
            <Line k="近 60 日" v={fmt(last.cost60)} />
            <Line
              k="現價相對 20 日"
              v={last.cost20 ? `${fmt(((last.close / last.cost20) - 1) * 100)}%` : '—'}
            />
            <Line k="當日均價" v={fmt(last.vwap)} />
          </Card>
          <Card title="均線">
            <Line k="MA5" v={fmt(last.ma5)} />
            <Line k="MA20" v={fmt(last.ma20)} />
            <Line k="MA60" v={fmt(last.ma60)} />
          </Card>
          <Card title="這段期間">
            <Line k="K 棒數" v={String(points.length)} />
            <Line k="起" v={points[0].date} />
            <Line k="迄" v={last.date} />
            <Line
              k="區間高低"
              v={`${fmt(Math.min(...points.map((p) => p.low)))} ~ ${fmt(Math.max(...points.map((p) => p.high)))}`}
            />
          </Card>
        </div>
      )}

      <div className="mt-6 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
        <p>
          <b>「主力成本」是近似值。</b>
          真正的主力成本要有法人或分點的買賣超資料，那是付費的。
          這裡用的是<b>區間內的成交金額 ÷ 成交股數</b>——也就是這段期間所有成交的加權平均價位，
          量大的日子自然佔比較重。分子分母都是官方數字，算式也看得見，
          但它代表的是「全市場的平均成本」，不是「特定主力的成本」。
        </p>
        <p className="mt-1">
          線圖資料來自 FinMind 的日線，每檔一次呼叫、不進資料庫。顏色用台股慣例：紅漲綠跌。
        </p>
      </div>
    </main>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <h2 className="mb-1.5 text-xs font-semibold text-zinc-500">{title}</h2>
      <dl className="space-y-0.5 text-sm">{children}</dl>
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-zinc-500">{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  );
}
