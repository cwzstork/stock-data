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
  '股號', '股名', '市場', '產業', '基準日',
  '收盤(當日)', '成交量(當日,張)', '成交額(當日,千元)',
  '殖利率(當日,交易所)%', '本益比(當日,近四季)', '股價淨值比(當日)', '股本(當期,百萬)',
  '毛利率(單季)%', '毛利率(累計)%',
  '營業利益率(單季)%', '營業利益率(累計)%',
  '稅後淨利率(單季)%', '稅後淨利率(累計)%',
  '營收成長率(單季年增)%', '營業利益成長率(單季年增)%', '稅後淨利成長率(單季年增)%',
  'ROE(近四季)%', 'ROE(累計年化)%', 'ROA(近四季)%', 'ROA(累計年化)%',
  '負債比(當期)%', '流動比(當期)%', 'EPS(單季)', 'EPS(近四季)', '每股淨值(當期)',
  '月營收年增%', '營收年增(累計)%', '預估EPS(自算)', '保守預估EPS(自算)',
  '年化殖利率(近12月)%', '現金股利(近12月)', '近12月配息次數',
  '均殖利率(5年均利÷現價)%', '均殖利率(10年均利÷現價)%', '連續配息(年)',
  '歷史殖利率(5年)%', '歷史殖利率(10年)%', '最低殖利率(5年)%',
  '現金股利(5年均)', '最低本益比(5年)', '最低價(5年)',
  '便宜價(股利法)', '便宜價(本益比法)', '便宜價(淨值法)',
  '董監持股(當期)%', '董監設質(當期)%', '經理人持股(當期)%', '大股東持股(當期)%',
  '財報期別',
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
        cell(r.gross_margin_q),
        cell(r.gross_margin),
        cell(r.op_margin_q),
        cell(r.op_margin),
        cell(r.net_margin_q),
        cell(r.net_margin),
        cell(r.rev_yoy),
        cell(r.op_yoy),
        cell(r.ni_yoy),
        cell(r.roe_ttm),
        cell(r.roe),
        cell(r.roa_ttm),
        cell(r.roa),
        cell(r.debt_ratio),
        cell(r.current_ratio),
        cell(r.eps),
        cell(r.eps_ttm),
        cell(r.bvps),
        cell(r.rev_m_yoy),
        cell(r.rev_ytd_yoy),
        cell(r.est_eps),
        cell(r.est_eps_low),
        cell(r.ttm_yield),
        cell(r.ttm_cash),
        cell(r.ttm_count),
        cell(r.yield5),
        cell(r.yield10),
        cell(r.streak),
        cell(r.hy5),
        cell(r.hy10),
        cell(r.hy5_min),
        cell(r.avg_div5),
        cell(r.min_per5),
        cell(r.low5),
        cell(r.cheap_div),
        cell(r.cheap_per),
        cell(r.cheap_pbr),
        cell(r.director_pct),
        cell(r.pledge_pct),
        cell(r.manager_pct),
        cell(r.major_pct),
        cell(r.period_end),
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
