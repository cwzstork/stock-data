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
  cost20: { color: '#ec4899', label: '主力成本20日' },
  cost60: { color: '#14b8a6', label: '主力成本60日' },
} as const;

type LineKey = keyof typeof LINES;

/** 預設開啟的線。全開會糊成一團，所以只先開最常看的 */
const DEFAULT_ON: LineKey[] = ['ma20', 'bbUpper', 'bbLower', 'cost20'];

const ts = (d: string) => (Date.parse(d + 'T00:00:00Z') / 1000) as UTCTimestamp;
const fmt = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d);
const lots = (v: number) => (v / 1000).toLocaleString('zh-TW', { maximumFractionDigits: 0 });

export default function StockChart({ points }: { points: ChartPoint[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Partial<Record<LineKey, ISeriesApi<'Line'>>>>({});
  const [on, setOn] = useState<Set<LineKey>>(new Set(DEFAULT_ON));
  // null = 游標不在圖上，顯示最後一根
  const [hover, setHover] = useState<ChartPoint | null>(null);

  const byTime = useMemo(() => {
    const m = new Map<number, ChartPoint>();
    for (const p of points) m.set(ts(p.date), p);
    return m;
  }, [points]);

  const shown = hover ?? points[points.length - 1];

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
  }, [points, byTime]);

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

      <div ref={boxRef} className="h-[460px] w-full" />

      <p className="mt-2 text-xs text-zinc-500">
        滑鼠移動看各日數字　·　拖曳平移　·　滾輪縮放　·　點上方圖例可開關線條
      </p>
    </div>
  );
}
