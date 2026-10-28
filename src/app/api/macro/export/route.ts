import { NextRequest } from 'next/server';
import { latestGeneratedAt, renderExportHtml, reportsInRange, storageStats } from '@/lib/macro-store';

export const dynamic = 'force-dynamic';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 宏觀事件預覽匯出成單一 HTML 檔：樣式內嵌、沒有外部相依，瀏覽器直接開、也可以列印成 PDF。
 *
 * 匯出的實際範圍放在回應標頭（x-macro-*），畫面拿它來問「要不要把這段刪掉」——
 * 刪除的範圍一定要跟檔案內容一致，不能拿使用者當初填的區間去刪。
 */
export async function GET(req: NextRequest) {
  const stats = await storageStats();
  if (stats.count === 0 || !stats.from || !stats.to) {
    return new Response('目前沒有任何報告可以匯出', { status: 404 });
  }

  const q = req.nextUrl.searchParams;
  const from = DATE.test(q.get('from') ?? '') ? q.get('from')! : stats.from;
  const to = DATE.test(q.get('to') ?? '') ? q.get('to')! : stats.to;

  const reports = await reportsInRange(from, to);
  if (reports.length === 0) {
    return new Response(`${from}～${to} 沒有報告`, { status: 404 });
  }
  const first = reports[0].reportDate;
  const last = reports[reports.length - 1].reportDate;
  const generatedMax = await latestGeneratedAt(first, last);

  return new Response(renderExportHtml(reports, first, last), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': `attachment; filename="macro-${first}_${last}.html"`,
      'cache-control': 'no-store',
      'x-macro-count': String(reports.length),
      'x-macro-from': first,
      'x-macro-to': last,
      'x-macro-generated-max': generatedMax ?? '',
    },
  });
}
