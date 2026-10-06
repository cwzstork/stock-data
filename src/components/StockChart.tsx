'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import Link from 'next/link';
import type { ChartPoint } from '@/lib/history';

/**
 * K 線圖。
 *
 * 用 lightweight-charts 而不是自己用 SVG 畫：拖曳平移、滾輪縮放、十字游標
 * 這三件事自己寫要好幾百行，而且在觸控裝置上很難做對。
 *
 * 游標移到哪裡，上方的讀數就顯示那一天的所有數字——這是「移動看時機點」
 * 的核心，所以讀數不是放在 tooltip 裡（會擋住線），而是固定在圖的上方。
 */

const LINES = {
  ma5: { color: '#f59e0b', label: 'MA5' },
  ma20: { color: '#3b82f6', label: 'MA20（布林中軌）' },
  ma60: { color: '#8b5cf6', label: 'MA60' },
  bbUpper: { color: '#94a3b8', label: '布林上軌' },
  bbLower: { color: '#94a3b8', label: '布林下軌' },
  cost20: { color: '#ec4899', label: '市場成本20日' },
  cost60: { color: '#14b8a6', label: '市場成本60日' },
  foreignCost20: { color: '#0ea5e9', label: '外資成本20日' },
  trustCost20: { color: '#f97316', label: '投信成本20日' },
} as const;

type LineKey = keyof typeof LINES;

/** 預設開啟的線。全開會糊成一團，所以只先開最常看的 */
const DEFAULT_ON: LineKey[] = ['ma20', 'bbUpper', 'bbLower', 'foreignCost20'];

/** 下方副圖可以選哪一個。放在獨立窗格，因為刻度跟股價完全不同 */
const PANES = {
  none: { label: '不顯示' },
  kd: { label: 'KD(9,3,3)' },
  rsi: { label: 'RSI(14)' },
  macd: { label: 'MACD(12,26,9)' },
  inst: { label: '法人買賣超' },
  chips: { label: '籌碼（外資持股／融資）' },
} as const;
type PaneKey = keyof typeof PANES;

/**
 * 籌碼副圖的資料要多打兩次 API，所以它走網址（?pane=chips）由伺服器抓，
 * 其餘幾個都是從 K 線現算的、純前端切換不用重新載入。
 * 這是刻意的不對稱：不為了選用的功能，在每次瀏覽都付固定成本。
 */
const SERVER_PANE: PaneKey = 'chips';

const ts = (d: string) => (Date.parse(d + 'T00:00:00Z') / 1000) as UTCTimestamp;
const fmt = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d);
const lots = (v: number) => (v / 1000).toLocaleString('zh-TW', { maximumFractionDigits: 0 });

export default function StockChart({
  points,
  initialPane = 'kd',
  chipsHref,
}: {
  points: ChartPoint[];
  initialPane?: PaneKey;
  /** 切到籌碼副圖要導去的網址 */
  chipsHref: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Partial<Record<LineKey, ISeriesApi<'Line'>>>>({});
  const [on, setOn] = useState<Set<LineKey>>(new Set(DEFAULT_ON));
  const [pane, setPane] = useState<PaneKey>(initialPane);
  // null = 游標不在圖上，顯示最後一根
  const [hover, setHover] = useState<ChartPoint | null>(null);

  const byTime = useMemo(() => {
    const m = new Map<number, ChartPoint>();
    for (const p of points) m.set(ts(p.date), p);
    return m;
  }, [points]);

  const shown = hover ?? points[points.length - 1];
  // 籌碼資料是伺服器視 ?pane=chips 才抓的，沒抓就不顯示相關讀數
  const hasChips = points.some((p) => p.foreignRatio !== null || p.marginBalance !== null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || points.length === 0) return;

    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: dark ? '#a1a1aa' : '#52525b',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: dark ? '#27272a' : '#f4f4f5' },
        horzLines: { color: dark ? '#27272a' : '#f4f4f5' },
      },
      rightPriceScale: { borderColor: dark ? '#3f3f46' : '#e4e4e7', scaleMargins: { top: 0.08, bottom: 0.28 } },
      timeScale: { borderColor: dark ? '#3f3f46' : '#e4e4e7', rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        locale: 'zh-TW',
        // 台股習慣：紅漲綠跌，而價格軸只要兩位小數
        priceFormatter: (p: number) => p.toFixed(2),
      },
    });
    chartRef.current = chart;

    // 台股的顏色慣例跟歐美相反：紅色是漲、綠色是跌
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#dc2626',
      downColor: '#16a34a',
      borderUpColor: '#dc2626',
      borderDownColor: '#16a34a',
      wickUpColor: '#dc2626',
      wickDownColor: '#16a34a',
    });
    candles.setData(
      points.map((p) => ({ time: ts(p.date), open: p.open, high: p.high, low: p.low, close: p.close })),
    );

    // 成交量疊在下方 28%，用獨立的價格刻度才不會把 K 線壓扁
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' } });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    vol.setData(
      points.map((p) => ({
        time: ts(p.date),
        value: p.volume,
        color: p.close >= p.open ? 'rgba(220,38,38,.35)' : 'rgba(22,163,74,.35)',
      })),
    );

    const lineSeries: Partial<Record<LineKey, ISeriesApi<'Line'>>> = {};
    for (const key of Object.keys(LINES) as LineKey[]) {
      const s = chart.addSeries(LineSeries, {
        color: LINES[key].color,
        lineWidth: key.startsWith('bb') ? 1 : 2,
        lineStyle: key.startsWith('bb') ? 2 : 0,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: on.has(key),
      });
      s.setData(
        points
          .filter((p) => p[key] !== null)
          .map((p) => ({ time: ts(p.date), value: p[key] as number })),
      );
      lineSeries[key] = s;
    }
    seriesRef.current = lineSeries;

    // ── 副圖（獨立窗格，刻度跟股價無關）──
    if (pane !== 'none') {
      const P = 1;
      const add = (color: string, key: keyof ChartPoint, width: 1 | 2 = 2) => {
        const ser = chart.addSeries(
          LineSeries,
          { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false },
          P,
        );
        ser.setData(
          points.filter((p) => p[key] !== null).map((p) => ({ time: ts(p.date), value: p[key] as number })),
        );
      };
      if (pane === 'kd') {
        add('#dc2626', 'k');
        add('#2563eb', 'd');
      } else if (pane === 'rsi') {
        add('#7c3aed', 'rsi');
      } else if (pane === 'macd') {
        add('#dc2626', 'dif');
        add('#2563eb', 'dem');
        const osc = chart.addSeries(HistogramSeries, { priceLineVisible: false }, P);
        osc.setData(
          points
            .filter((p) => p.osc !== null)
            .map((p) => ({
              time: ts(p.date),
              value: p.osc as number,
              color: (p.osc as number) >= 0 ? 'rgba(220,38,38,.5)' : 'rgba(22,163,74,.5)',
            })),
        );
      } else if (pane === 'chips') {
        // 兩者刻度天差地遠（持股比率是 %，融資餘額是張），各用一個價格軸
        const fr = chart.addSeries(
          LineSeries,
          { color: '#0ea5e9', lineWidth: 2, priceScaleId: 'fr', priceLineVisible: false },
          P,
        );
        fr.setData(
          points.filter((p) => p.foreignRatio !== null)
            .map((p) => ({ time: ts(p.date), value: p.foreignRatio as number })),
        );
        const mg = chart.addSeries(
          LineSeries,
          { color: '#f97316', lineWidth: 2, priceScaleId: 'mg', priceLineVisible: false },
          P,
        );
        mg.setData(
          points.filter((p) => p.marginBalance !== null)
            .map((p) => ({ time: ts(p.date), value: p.marginBalance as number })),
        );
      } else if (pane === 'inst') {
        // 外資用柱狀最直觀：紅買綠賣，一眼看出連續買超的區段
        const fo = chart.addSeries(HistogramSeries, { priceLineVisible: false }, P);
        fo.setData(
          points
            .filter((p) => p.foreignNet !== null)
            .map((p) => ({
              time: ts(p.date),
              value: p.foreignNet as number,
              color: (p.foreignNet as number) >= 0 ? 'rgba(220,38,38,.6)' : 'rgba(22,163,74,.6)',
            })),
        );
        add('#f97316', 'trustNet', 1);
      }
      chart.panes()[P]?.setHeight(130);
    }

    chart.subscribeCrosshairMove((param) => {
      const t = param.time as number | undefined;
      setHover(t === undefined ? null : (byTime.get(t) ?? null));
    });

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = {};
    };
  }, [points, byTime, pane]);

  // 切換線條只改 visible，不重建整張圖——重建會把使用者拉好的縮放位置清掉
  useEffect(() => {
    for (const key of Object.keys(LINES) as LineKey[]) {
      seriesRef.current[key]?.applyOptions({ visible: on.has(key) });
    }
  }, [on]);

  if (points.length === 0) {
    return <p className="py-16 text-center text-sm text-zinc-500">這段期間沒有交易資料</p>;
  }

  const up = shown.close >= shown.open;
  const chg = shown.close - shown.open;

  return (
    <div>
      {/* 讀數列：游標移到哪一天就顯示那天的數字，沒移就顯示最後一根 */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm tabular-nums">
        <span className="font-mono text-zinc-500">{shown.date}</span>
        <span className={up ? 'text-red-600' : 'text-green-600'}>
          收 <b className="text-base">{fmt(shown.close)}</b>
          <span className="ml-1 text-xs">
            {chg >= 0 ? '+' : ''}
            {fmt(chg)}（{fmt((chg / shown.open) * 100)}%）
          </span>
        </span>
        <span className="text-zinc-500">
          開 {fmt(shown.open)}　高 {fmt(shown.high)}　低 {fmt(shown.low)}
        </span>
        <span className="text-zinc-500">量 {lots(shown.volume)} 張</span>
        <span className="text-zinc-500">均價 {fmt(shown.vwap)}</span>
      </div>

      {/* 游標那一天的震盪指標與法人動向 */}
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-zinc-500">
        <span>
          K <b>{fmt(shown.k)}</b> / D <b>{fmt(shown.d)}</b>
        </span>
        <span>
          RSI <b>{fmt(shown.rsi)}</b>
        </span>
        <span>
          MACD DIF <b>{fmt(shown.dif)}</b> 訊號 <b>{fmt(shown.dem)}</b> 柱{' '}
          <b className={(shown.osc ?? 0) >= 0 ? 'text-red-600' : 'text-green-600'}>{fmt(shown.osc)}</b>
        </span>
        {hasChips && (
          <span>
            外資持股 <b>{fmt(shown.foreignRatio)}%</b>　融資{' '}
            <b>{fmt(shown.marginBalance, 0)}</b> 張　融券{' '}
            <b>{fmt(shown.shortBalance, 0)}</b> 張
          </span>
        )}
        <span>
          法人淨買超（張）外資{' '}
          <b className={(shown.foreignNet ?? 0) >= 0 ? 'text-red-600' : 'text-green-600'}>
            {fmt(shown.foreignNet, 0)}
          </b>
          　投信{' '}
          <b className={(shown.trustNet ?? 0) >= 0 ? 'text-red-600' : 'text-green-600'}>
            {fmt(shown.trustNet, 0)}
          </b>
          　自營{' '}
          <b className={(shown.dealerNet ?? 0) >= 0 ? 'text-red-600' : 'text-green-600'}>
            {fmt(shown.dealerNet, 0)}
          </b>
        </span>
      </div>

      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
        {(Object.keys(LINES) as LineKey[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() =>
              setOn((cur) => {
                const next = new Set(cur);
                if (next.has(k)) next.delete(k);
                else next.add(k);
                return next;
              })
            }
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition ${
              on.has(k) ? 'bg-zinc-100 dark:bg-zinc-800' : 'opacity-40 hover:opacity-70'
            }`}
            title={on.has(k) ? '點一下隱藏' : '點一下顯示'}
          >
            <span className="inline-block h-0.5 w-3" style={{ background: LINES[k].color }} />
            {LINES[k].label}
            <b>{fmt(shown[k])}</b>
          </button>
        ))}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs">
        <span className="mr-1 text-zinc-500">副圖</span>
        {(Object.keys(PANES) as PaneKey[]).map((p) => {
          const cls = `rounded px-2 py-0.5 transition ${
            p === pane
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300'
          }`;
          // 籌碼的資料不在這張圖裡，要回伺服器拿，所以是連結不是按鈕
          if (p === SERVER_PANE && !hasChips) {
            return (
              <Link key={p} href={chipsHref} className={cls} prefetch={false}>
                {PANES[p].label}
              </Link>
            );
          }
          return (
            <button key={p} type="button" onClick={() => setPane(p)} className={cls}>
              {PANES[p].label}
            </button>
          );
        })}
      </div>

      <div ref={boxRef} className={pane === 'none' ? 'h-[460px] w-full' : 'h-[600px] w-full'} />

      <p className="mt-2 text-xs text-zinc-500">
        滑鼠移動看各日數字　·　拖曳平移　·　滾輪縮放　·　點上方圖例可開關線條
      </p>
    </div>
  );
}
