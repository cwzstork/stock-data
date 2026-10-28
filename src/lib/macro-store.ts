/**
 * 宏觀事件預覽的讀取與匯出。寫入在 scripts/macro.ts，刪除在 macro-actions.ts。
 */

import { prisma } from './prisma';
import type { MacroImpact, MacroNews, MacroPayload, MacroThemeResult, Tone } from './macro';
import { CATEGORIES, HORIZONS } from './macro-rules';

export interface StoredReport {
  reportDate: string;
  /** 台北時間 YYYY-MM-DD HH:MM，顯示用 */
  generatedAt: string;
  payload: MacroPayload;
}

const SELECT = `SELECT to_char(report_date, 'YYYY-MM-DD') AS "reportDate",
                       to_char(generated_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') AS "generatedAt",
                       payload
                  FROM macro_report`;

/** 最新的幾份。before 是分頁用：只取這天以前的 */
export async function listReports(limit: number, before?: string): Promise<StoredReport[]> {
  return before
    ? prisma.$queryRawUnsafe<StoredReport[]>(
        `${SELECT} WHERE report_date < $1::date ORDER BY report_date DESC LIMIT ${Number(limit)}`,
        before,
      )
    : prisma.$queryRawUnsafe<StoredReport[]>(`${SELECT} ORDER BY report_date DESC LIMIT ${Number(limit)}`);
}

/** 匯出用：區間內全部，舊到新 */
export async function reportsInRange(from: string, to: string): Promise<StoredReport[]> {
  return prisma.$queryRawUnsafe<StoredReport[]>(
    `${SELECT} WHERE report_date BETWEEN $1::date AND $2::date ORDER BY report_date`,
    from,
    to,
  );
}

/**
 * 區間內最晚的產生時間（ISO，毫秒）。刪除時只刪「產生時間 <= 這個值」的，
 * 匯出之後排程才重跑覆蓋的那天不會被一起刪掉——那份內容不在剛匯出的檔案裡。
 */
export async function latestGeneratedAt(from: string, to: string): Promise<string | null> {
  const [row] = await prisma.$queryRawUnsafe<{ t: Date | null }[]>(
    `SELECT max(generated_at) AS t FROM macro_report WHERE report_date BETWEEN $1::date AND $2::date`,
    from,
    to,
  );
  return row?.t ? row.t.toISOString() : null;
}

export interface StorageStats {
  count: number;
  from: string | null;
  to: string | null;
  /** 整張表（含索引與 TOAST）佔用 */
  bytes: number;
}

export async function storageStats(): Promise<StorageStats> {
  const [r] = await prisma.$queryRawUnsafe<
    { count: bigint; from: string | null; to: string | null; bytes: bigint }[]
  >(
    `SELECT count(*) AS count,
            to_char(min(report_date), 'YYYY-MM-DD') AS "from",
            to_char(max(report_date), 'YYYY-MM-DD') AS "to",
            pg_total_relation_size('macro_report') AS bytes
       FROM macro_report`,
  );
  return { count: Number(r.count), from: r.from, to: r.to, bytes: Number(r.bytes) };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// ── 顯示用的共用小工具（畫面與匯出都用）────────────────────────────────

export const EFFECT_LABEL: Record<Tone, string> = { 1: '利多', [-1]: '利空', 0: '看新聞' };
export const TONE_LABEL: Record<Tone, string> = { 1: '正向', [-1]: '反向', 0: '方向不明' };

/**
 * 主題反向或看不出方向時，表格上方的一句說明。
 * 理由欄寫的是不帶方向的傳導關係（「存貨評價跟著油價走」），利多利空才是當天的結論。
 */
export const TONE_HINT: Record<Tone, string> = {
  1: '',
  [-1]: '今天整體是反向（例如停火、降溫、價格下跌、管制放寬），下表的利多利空已經依此反過來。',
  0: '今天正反消息抵銷或標題看不出方向，下表只列出會受影響的個股，方向要看新聞內容。',
};

/** 台北時間 MM-DD HH:MM */
export function shortTime(iso: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function newsById(payload: MacroPayload): Map<string, MacroNews> {
  return new Map(payload.news.map((n) => [n.id, n]));
}

export function horizonText(i: MacroImpact): string {
  const h = HORIZONS[i.horizon];
  return `${h.label}（${h.range}）`;
}

/** 正反則數的說明，例如「新聞 23 則：正向 20、反向 3」 */
export function themeCounts(t: MacroThemeResult): string {
  const parts = [`正向 ${t.positive}`, `反向 ${t.negative}`];
  if (t.neutral) parts.push(`看不出方向 ${t.neutral}`);
  return `新聞 ${t.newsCount} 則：${parts.join('、')}`;
}

/** 沒對到主題、依來源分類留下的新聞 */
export function otherNews(payload: MacroPayload): [string, MacroNews[]][] {
  const groups = new Map<string, MacroNews[]>();
  for (const n of payload.news) {
    if (n.hits.length > 0 || !n.category) continue;
    const label = CATEGORIES[n.category];
    groups.set(label, [...(groups.get(label) ?? []), n]);
  }
  return [...groups.entries()];
}

// ── 匯出 HTML ────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function effectHtml(e: Tone): string {
  return `<span class="e${e}">${EFFECT_LABEL[e]}</span>`;
}

function reportHtml({ reportDate, generatedAt, payload: p }: StoredReport): string {
  const byId = newsById(p);
  const indicators = p.indicators
    .map(
      (i) =>
        `<tr><td>${esc(i.label)}</td><td>${esc(i.value)}</td><td>${esc(i.change)}</td><td>${esc(i.asOf ?? '')}</td><td class="muted">${esc(i.note)}</td></tr>`,
    )
    .join('');

  const themes = p.themes
    .map((t) => {
      const impacts = t.impacts
        .map(
          (i) =>
            `<tr><td>${esc(i.stockId)}</td><td>${esc(i.stockName)}</td><td>${effectHtml(i.effect)}</td><td>${esc(horizonText(i))}</td><td>${esc(i.why)}</td></tr>`,
        )
        .join('');
      const news = t.newsIds
        .map((id) => byId.get(id))
        .filter((n): n is MacroNews => Boolean(n))
        .map(
          (n) =>
            `<li><a href="${esc(n.link)}">${esc(n.title)}</a> <span class="muted">${esc(n.source)}・${shortTime(n.publishedAt)}</span></li>`,
        )
        .join('');
      const ind = t.indicatorKeys.length
        ? `<p class="muted">指標觸發：${esc(t.indicatorKeys.map((k) => p.indicators.find((i) => i.key === k)?.label ?? k).join('、'))}</p>`
        : '';
      return `<section class="theme">
<h3>${esc(t.label)} <small>${esc(CATEGORIES[t.category])}・整體${TONE_LABEL[t.tone]}</small></h3>
<p>${esc(t.summary)}</p>
<p class="muted">${esc(themeCounts(t))}</p>${ind}${TONE_HINT[t.tone] ? `<p class="muted">${esc(TONE_HINT[t.tone])}</p>` : ''}
<table><thead><tr><th>股號</th><th>股名</th><th>影響</th><th>週期</th><th>理由</th></tr></thead><tbody>${impacts}</tbody></table>
<ul>${news}</ul>
</section>`;
    })
    .join('');

  const others = otherNews(p)
    .map(
      ([label, list]) =>
        `<h4>${esc(label)}</h4><ul>${list
          .map((n) => `<li><a href="${esc(n.link)}">${esc(n.title)}</a> <span class="muted">${esc(n.source)}</span></li>`)
          .join('')}</ul>`,
    )
    .join('');

  return `<article>
<h2>${reportDate}</h2>
<p class="muted">產生於 ${generatedAt}（台北）・新聞期間 ${shortTime(p.windowFrom)} ～ ${shortTime(p.windowTo)}・抓到 ${p.stats.unique} 則、對到主題 ${p.stats.matched} 則</p>
<table><thead><tr><th>指標</th><th>數值</th><th>變動</th><th>資料日</th><th>說明</th></tr></thead><tbody>${indicators}</tbody></table>
${themes || '<p class="muted">這天沒有新聞對到任何主題。</p>'}
${others ? `<details><summary>其他新聞</summary>${others}</details>` : ''}
</article>`;
}

export function renderExportHtml(reports: StoredReport[], from: string, to: string): string {
  return `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>宏觀事件預覽 ${from}～${to}</title>
<style>
body{font-family:system-ui,-apple-system,"Noto Sans TC","Microsoft JhengHei",sans-serif;max-width:960px;margin:0 auto;padding:16px;color:#18181b;line-height:1.6}
h1{font-size:1.5rem}h2{border-bottom:2px solid #18181b;padding-bottom:4px;margin-top:2.5rem}h3{margin:1.5rem 0 .25rem}h3 small{font-weight:normal;color:#71717a;font-size:.8rem}
table{border-collapse:collapse;width:100%;font-size:.875rem;margin:.5rem 0}th,td{border:1px solid #e4e4e7;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f4f4f5}
.muted{color:#71717a;font-size:.85rem}.e1{color:#dc2626;font-weight:600}.e-1{color:#15803d;font-weight:600}.e0{color:#71717a}
ul{padding-left:1.2rem;font-size:.875rem}a{color:#0369a1}.theme{page-break-inside:avoid}
.note{background:#fffbeb;border:1px solid #fde68a;padding:8px 12px;border-radius:6px;font-size:.875rem}
</style>
</head>
<body>
<h1>宏觀事件預覽 ${from}～${to}</h1>
<p class="note">共 ${reports.length} 份。這是<strong>關鍵字規則比對</strong>的結果，不是 AI 判讀，也不是投資建議：
新聞標題對到預先寫好的主題，再列出這類消息<strong>通常</strong>會牽動的個股。
方向「利多／利空」是主題往當天整體方向發展時的一般情況，週期是這類消息通常反映在股價上的時間。
台股習慣紅色代表利多、綠色代表利空。</p>
${reports.map(reportHtml).join('\n')}
</body>
</html>
`;
}
