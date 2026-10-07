import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { fetchLiveQuotes } from '@/lib/live';
import {
  fetchBars,
  fetchInstMap,
  fetchChips,
  withIndicators,
  sliceRange,
  aggregateBars,
  aggregateInst,
  aggregateChips,
  RANGES,
  TIMEFRAMES,
  isRangeKey,
  isTimeframe,
  type RangeKey,
  type Timeframe,
} from '@/lib/history';
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
  const tfRaw = typeof sp.tf === 'string' ? sp.tf : null;
  const tf: Timeframe = isTimeframe(tfRaw) ? tfRaw : 'day';
  const rangeRaw = typeof sp.range === 'string' ? sp.range : null;
  // 沒指定期間時依週期給合理的預設：週線看 3 個月只有 13 根，太稀疏
  const range: RangeKey = isRangeKey(rangeRaw) ? rangeRaw : TIMEFRAMES[tf].defaultRange;
  // 籌碼面要多打兩次 API，只在明確要看時才抓
  const wantChips = sp.pane === 'chips';

  const [stock] = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT stock_id, stock_name, market, industry_category FROM stock WHERE stock_id = $1`,
    id,
  );
  if (!stock) notFound();

  // 三者互不相干，一起等就好。任何一個掛掉都不該讓整頁空白
  const [barsResult, inst, chips, quotes] = await Promise.all([
    fetchBars(id, START_DATE),
    fetchInstMap(id, START_DATE).catch(() => new Map()),
    wantChips ? fetchChips(id, START_DATE).catch(() => new Map()) : Promise.resolve(undefined),
    fetchLiveQuotes([{ stockId: id, market: stock.market }]).catch(() => []),
  ]);
  const live = quotes[0];
  const daily = barsResult.ok ? barsResult.bars : [];
  // 先聚合成週／月 K，再在聚合後的資料上算指標——
  // 這樣週線的 MA20 才是真的「20 週均線」，而不是 20 日線畫在週圖上。
  const bars = aggregateBars(daily, tf);
  const points = sliceRange(
    withIndicators(bars, aggregateInst(daily, tf, inst), aggregateChips(daily, tf, chips)),
    range,
  );
  const last = points[points.length - 1];
  // 籌碼與法人都是盤後才公布，所以最後一根（今天）通常是空的。
  // 卡片要顯示的是「目前已知的最新值」，不是「最後一根 K 棒的值」，
  // 否則盤中整張卡會變成一排「—」，看起來像壞掉。
  const latestChip = [...points].reverse().find((p) => p.foreignRatio !== null);
  // 法人資料抓不到不影響 K 線，但要讓使用者知道那幾欄為什麼是空的
  const instMissing = barsResult.ok && bars.length > 0 && inst.size === 0;

  // 切換期間／週期時把其他選擇帶著走，不然換一個就會把另一個重置掉
  const suffix = `${tf === 'day' ? '' : `&tf=${tf}`}${wantChips ? '&pane=chips' : ''}`;
  const keep = (r: RangeKey) => `/stock/${id}?range=${r}${suffix}`;
  const keepTf = (t: Timeframe) =>
    `/stock/${id}?range=${range}${t === 'day' ? '' : `&tf=${t}`}${wantChips ? '&pane=chips' : ''}`;

  return (
    <main className="mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">
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

      <div className="mt-4 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-zinc-500">週期</span>
        {(Object.keys(TIMEFRAMES) as Timeframe[]).map((t) => (
          <Link
            key={t}
            href={keepTf(t)}
            className={`rounded px-4 py-2 text-sm font-medium transition sm:px-3 sm:py-1 ${
              t === tf
                ? 'bg-sky-600 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
            }`}
          >
            {TIMEFRAMES[t].label}
          </Link>
        ))}
      </div>

      <div className="mb-4 mt-2 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-zinc-500">期間</span>
        {(Object.keys(RANGES) as RangeKey[]).map((r) => (
          <Link
            key={r}
            href={keep(r)}
            className={`rounded px-4 py-2 text-sm transition sm:px-3 sm:py-1 ${
              r === range
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
            }`}
          >
            {RANGES[r].label}
          </Link>
        ))}
      </div>

      {!barsResult.ok && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/30">
          {barsResult.reason === 'quota' ? (
            <>
              <p className="font-semibold">FinMind 的每小時額度暫時用完了，不是資料有問題。</p>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                免費層是 600 次/小時，歷史回補跑的時候會用掉一部分。
                等幾分鐘重新整理就會回來。
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold">線圖資料暫時拿不到。</p>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                上游回應：{barsResult.message}
              </p>
            </>
          )}
        </div>
      )}

      {barsResult.ok && (
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <StockChart
            points={points}
            initialPane={wantChips ? 'chips' : 'kd'}
            chipsHref={`/stock/${id}?range=${range}${tf === 'day' ? '' : `&tf=${tf}`}&pane=chips`}
            unit={TIMEFRAMES[tf].unit}
          />
          {instMissing && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-500">
              法人買賣超這次沒拿到，所以法人成本與買賣超那幾欄是空的。K 線本身不受影響。
            </p>
          )}
        </div>
      )}

      {last && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card title={`布林通道（20${TIMEFRAMES[tf].unit},2倍標準差）`}>
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
          <Card title={`法人成本（近20${TIMEFRAMES[tf].unit}買超加權均價）`}>
            <Line k="外資" v={fmt(last.foreignCost20)} />
            <Line k="投信" v={fmt(last.trustCost20)} />
            <Line
              k="現價相對外資成本"
              v={
                last.foreignCost20
                  ? `${fmt((last.close / last.foreignCost20 - 1) * 100)}%`
                  : '—'
              }
            />
            <Line k="外資近20日累計" v={`${fmt(last.foreignNet20, 0)} 張`} />
          </Card>
          <Card title="市場成本">
            <Line k={`市場成本20${TIMEFRAMES[tf].unit}`} v={fmt(last.cost20)} />
            <Line k={`市場成本60${TIMEFRAMES[tf].unit}`} v={fmt(last.cost60)} />
            <Line k="當日均價" v={fmt(last.vwap)} />
          </Card>
          <Card title="技術指標">
            <Line k="K / D" v={`${fmt(last.k)} / ${fmt(last.d)}`} />
            <Line k="RSI(14)" v={fmt(last.rsi)} />
            <Line k="MACD 柱" v={fmt(last.osc)} />
            <Line k="MA5 / 10 / 20" v={`${fmt(last.ma5, 0)} / ${fmt(last.ma10, 0)} / ${fmt(last.ma20, 0)}`} />
          </Card>
          {wantChips && (
            <Card
              title={`籌碼面${latestChip && latestChip.date !== last.date ? `（至 ${latestChip.date}）` : ''}`}
            >
              <Line
                k="外資持股比率"
                v={latestChip ? `${fmt(latestChip.foreignRatio)}%` : '—'}
              />
              <Line k="融資餘額" v={latestChip ? `${fmt(latestChip.marginBalance, 0)} 張` : '—'} />
              <Line k="融券餘額" v={latestChip ? `${fmt(latestChip.shortBalance, 0)} 張` : '—'} />
              <Line
                k="外資持股區間變化"
                v={(() => {
                  const withFr = points.filter((p) => p.foreignRatio !== null);
                  if (withFr.length < 2) return '—';
                  const d =
                    (withFr[withFr.length - 1].foreignRatio as number) -
                    (withFr[0].foreignRatio as number);
                  return `${d >= 0 ? '+' : ''}${fmt(d)} 個百分點`;
                })()}
              />
            </Card>
          )}
          <Card title="這段期間">
            <Line k={`K 棒數（${TIMEFRAMES[tf].label}）`} v={String(points.length)} />
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
          <b>兩種「成本」不一樣，別混用。</b>
        </p>
        <p className="mt-1">
          <b>法人成本</b>＝近 20 日裡<b>有買超的那幾天</b>，用當日淨買超股數加權當日均價。
          只算買超日是刻意的——這一條回答的是「他們在什麼價位買進」，
          把賣超日也算進去會變成買賣相抵後的殘值，失去成本的意義。
          這是用三大法人的實際買賣超算的，不是近似。
        </p>
        <p className="mt-1">
          <b>市場成本</b>＝區間內的成交金額 ÷ 成交股數，也就是<b>全市場</b>的加權平均價位。
          它不分買方賣方，代表的是「所有成交的平均價」，跟特定法人無關。
        </p>
        <p className="mt-1">
          <b>籌碼副圖</b>是外資持股比率（藍）與融資餘額（橘）。
          分點買賣超與股權分散表在 FinMind 免費層拿不到（回 HTTP 400），
          但這兩個其實更適合看趨勢——分點只看得到當天，持股比率看得到十年。
          外資降、融資升代表籌碼從法人流向散戶。
          這兩筆資料要多打兩次 API，所以只在切到籌碼副圖時才抓。
        </p>
        <p className="mt-1">
          法人買賣超是<b>盤後</b>才公布，所以當天的數字在收盤前會是 0。
          線圖與法人資料都來自 FinMind，每檔各一次呼叫、不進資料庫。顏色用台股慣例：紅漲綠跌。
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
