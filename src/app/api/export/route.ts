import { NextRequest } from 'next/server';
import {
  MARKET_LABEL,
  getTradeDates,
  parseFilters,
  runScreenerForExport,
  type RawParams,
} from '@/lib/screener';

export const dynamic = 'force-dynamic';

const HEADERS = [
  '股號',
  '股名',
  '市場',
  '產業',
  '基準日',
  '收盤',
  '成交量(張)',
  '成交額(千元)',
  '殖利率(%)',
  '本益比',
  '股價淨值比',
  '股本(百萬)',
  '毛利率(%)',
  '營益率(%)',
  '淨利率(%)',
  'ROE年化(%)',
  '負債比(%)',
  'EPS(累計)',
  '每股淨值',
  '財報期別',
  '年化殖利率(%)',
  '近12月股利',
  '近12月配息次數',
  '5年均殖(%)',
  '10年均殖(%)',
  '連續配息(年)',
];

/** CSV 逃脫：含逗號、引號或換行就要包起來，引號自身要加倍 */
function cell(v: string | null | number): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function divide(v: string | null, divisor: number): string {
  return v === null ? '' : String(Math.round(Number(v) / divisor));
}

export async function GET(req: NextRequest) {
  const params: RawParams = {};
  for (const key of new Set(req.nextUrl.searchParams.keys())) {
    const all = req.nextUrl.searchParams.getAll(key);
    params[key] = all.length > 1 ? all : all[0];
  }

  const f = parseFilters(params);
  const rows = await runScreenerForExport(f, await getTradeDates());

  const lines = [HEADERS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        // 股號前面補上定位字元，否則 Excel 會把 0050 吃成 50
        cell(`="${r.stock_id}"`),
        cell(r.stock_name),
        cell(MARKET_LABEL[r.market] ?? r.market),
        cell(r.industry_category),
        cell(r.trade_date),
        cell(r.close),
        cell(divide(r.volume, 1000)),
        cell(divide(r.turnover, 1000)),
        cell(r.dividend_yield),
        cell(r.per),
        cell(r.pbr),
        cell(divide(r.capital, 1e6)),
        cell(r.gross_margin),
        cell(r.op_margin),
        cell(r.net_margin),
        cell(r.roe),
        cell(r.debt_ratio),
        cell(r.eps),
        cell(r.bvps),
        cell(r.period_end),
        cell(r.ttm_yield),
        cell(r.ttm_cash),
        cell(r.ttm_count),
        cell(r.yield5),
        cell(r.yield10),
        cell(r.streak),
      ].join(','),
    );
  }

  const date = rows[0]?.trade_date ?? 'empty';
  // BOM：沒有它 Excel 會用系統預設編碼開檔，中文全變亂碼
  const body = '﻿' + lines.join('\r\n') + '\r\n';

  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="screener-${date}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
