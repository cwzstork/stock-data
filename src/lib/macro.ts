/**
 * 宏觀事件預覽：收集新聞與指標、比對主題、產生一天的報告。
 *
 * 流程：
 *   1. 抓 FEEDS 裡的 RSS（Google 新聞搜尋、Fed、EIA、Yahoo 股市），同標題去重
 *   2. 只留這次時間窗裡發布的（接在上一份報告後面，不重複也不漏）
 *   3. 每則標題逐一比對 THEMES 的關鍵字，判斷方向
 *   4. 抓 FinMind 的外資、匯率、油價、美債，波動夠大就也算一筆主題證據
 *   5. 有證據的主題列出受影響個股，方向 = 規則方向 × 當天的整體方向
 *
 * 規則與個股清單在 macro-rules.ts，這裡只負責流程。不寫資料庫——由 scripts/macro.ts 寫。
 */

import { createHash } from 'node:crypto';
import {
  fetchBondYield,
  fetchCrudeOil,
  fetchExchangeRate,
  fetchMarketInstitutional,
} from './finmind';
import { fetchText, mapLimit } from './http';
import {
  DOWN_WORDS,
  FEEDS,
  INDICATOR_RULES,
  THEMES,
  UP_WORDS,
  type Category,
  type FeedSource,
  type Horizon,
  type Theme,
} from './macro-rules';

export type Tone = 1 | -1 | 0;

export interface MacroNews {
  id: string;
  title: string;
  link: string;
  /** 媒體名稱 */
  source: string;
  /** 從哪個 FEEDS 抓到的 */
  feed: string;
  publishedAt: string;
  /** 沒對到主題時歸類用；綜合來源（Yahoo）是 null */
  category: Category | null;
  hits: { theme: string; tone: Tone }[];
}

export interface MacroIndicator {
  key: 'foreign' | 'usdtwd' | 'wti' | 'us10y';
  label: string;
  /** 最新一筆的資料日期 */
  asOf: string | null;
  value: string;
  change: string;
  /** 資料太舊，不拿來觸發主題 */
  stale: boolean;
  note: string;
  trigger: { theme: string; tone: 1 | -1 } | null;
}

export interface MacroImpact {
  stockId: string;
  stockName: string;
  /** 1 利多、-1 利空、0 方向不明（當天正反消息抵銷，或標題看不出漲跌） */
  effect: Tone;
  horizon: Horizon;
  why: string;
}

export interface MacroThemeResult {
  id: string;
  label: string;
  category: Category;
  summary: string;
  tone: Tone;
  /** 對到這個主題的新聞總則數，與其中正向、反向、看不出方向的則數 */
  newsCount: number;
  positive: number;
  negative: number;
  neutral: number;
  /** 留下來當證據的新聞（最新的 EVIDENCE_PER_THEME 則）。其餘只計入上面的則數 */
  newsIds: string[];
  indicatorKeys: string[];
  impacts: MacroImpact[];
}

export interface MacroPayload {
  version: 1;
  windowFrom: string;
  windowTo: string;
  sources: { id: string; label: string; ok: boolean; items: number; error?: string }[];
  indicators: MacroIndicator[];
  themes: MacroThemeResult[];
  news: MacroNews[];
  stats: {
    /** 所有來源合計抓到的則數 */
    fetched: number;
    /** 同標題去重後 */
    unique: number;
    /** 落在時間窗裡 */
    inWindow: number;
    /** 對到至少一個主題 */
    matched: number;
    /** 實際存進報告的（對到主題的全部 ＋ 每類最多幾則其他新聞） */
    stored: number;
  };
  /** 規則裡股號或股名對不上主檔、被丟掉的個股 */
  warnings: string[];
}

/**
 * 每個主題留幾則新聞當證據、每一類「沒對到主題」的新聞留幾則。
 *
 * 全留的話實測一天 594 則、333 KB，一年 120 MB，會吃掉免費層四分之一。
 * 熱門主題（中東情勢一天 110 則）多半是同一件事的不同報導，留最新幾則就看得出在講什麼，
 * 總則數與正反則數照樣用全部新聞算。
 */
const EVIDENCE_PER_THEME = 8;
const OTHER_NEWS_PER_CATEGORY = 5;
/** 沒有上一份報告（或隔太久）時，往回抓多久 */
const DEFAULT_WINDOW_MS = 24 * 3600_000;
const MAX_WINDOW_MS = 48 * 3600_000;
/** 指標觸發的主題，權重相當於幾則新聞。數據比標題可靠，所以給高一點 */
const INDICATOR_WEIGHT = 3;

const USER_AGENT = 'Mozilla/5.0 (compatible; stock-macro/1.0; +https://github.com/cwzstork/stock-data)';

/** 台北日期 YYYY-MM-DD */
export function taipeiDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

// ── RSS ─────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : null;
}

interface RawItem {
  title: string;
  link: string;
  source: string;
  publishedAt: Date;
  feed: FeedSource;
}

/** 不引入 XML 套件：RSS 2.0 的 item 結構固定，四個欄位用正規式就夠了 */
export function parseRss(xml: string, feed: FeedSource): RawItem[] {
  const out: RawItem[] = [];
  for (const [, body] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    let title = tag(body, 'title');
    const link = tag(body, 'link');
    const date = new Date(tag(body, 'pubDate') ?? '');
    if (!title || !link || Number.isNaN(date.getTime())) continue;

    // Google 新聞的標題結尾會接「 - 媒體名」，跟 <source> 重複，拿掉
    const source = tag(body, 'source') ?? feed.label.split('：')[0];
    if (title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();

    out.push({ title, link, source, publishedAt: date, feed });
  }
  return out;
}

/** 同一則新聞常被好幾個查詢抓到，標題去掉標點空白後比對 */
function titleKey(title: string): string {
  return title.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase().slice(0, 60);
}

async function collectNews() {
  const sources: MacroPayload['sources'] = [];
  const items: RawItem[] = [];

  await mapLimit(FEEDS, 4, async (feed) => {
    try {
      const xml = await fetchText(feed.url, { label: feed.label, headers: { 'user-agent': USER_AGENT } });
      const parsed = parseRss(xml, feed);
      items.push(...parsed);
      sources.push({ id: feed.id, label: feed.label, ok: true, items: parsed.length });
    } catch (e) {
      sources.push({ id: feed.id, label: feed.label, ok: false, items: 0, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 照 FEEDS 的順序排回來，畫面與 log 才穩定
  const order = new Map(FEEDS.map((f, i) => [f.id, i]));
  sources.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { sources, items };
}

// ── 主題比對 ─────────────────────────────────────────────────────────

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

function toneOf(theme: Theme, title: string): Tone {
  if (theme.mode === 'fixed') {
    return theme.reverse?.test(title) && !theme.reverseExcept?.test(title) ? -1 : 1;
  }
  const up = count(title, theme.up ?? UP_WORDS);
  const down = count(title, theme.down ?? DOWN_WORDS);
  return Math.sign(up - down) as Tone;
}

export function matchThemes(title: string): { theme: string; tone: Tone }[] {
  const hits: { theme: string; tone: Tone }[] = [];
  for (const theme of THEMES) {
    if (!theme.match.test(title) || theme.exclude?.test(title)) continue;
    hits.push({ theme: theme.id, tone: toneOf(theme, title) });
  }
  return hits;
}

// ── 量化指標 ─────────────────────────────────────────────────────────

function signed(v: number, digits = 0): string {
  const s = v.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return v > 0 ? `+${s}` : s;
}

/** 取最後一筆與往前第 5 筆。資料不足 6 筆就拿最早那筆比 */
function lastVsFiveBack<T>(rows: T[]): [T, T] | null {
  if (rows.length < 2) return null;
  return [rows[rows.length - 1], rows[Math.max(0, rows.length - 6)]];
}

async function safely<T>(label: string, fn: () => Promise<T>): Promise<T | Error> {
  try {
    return await fn();
  } catch (e) {
    return new Error(`${label}：${e instanceof Error ? e.message : String(e)}`);
  }
}

function failed(key: MacroIndicator['key'], label: string, err: Error): MacroIndicator {
  return { key, label, asOf: null, value: '—', change: '', stale: true, note: `抓不到：${err.message}`, trigger: null };
}

async function collectIndicators(today: string): Promise<MacroIndicator[]> {
  const start = new Date(Date.parse(today) - 40 * 86_400_000).toISOString().slice(0, 10);
  const R = INDICATOR_RULES;
  const isStale = (asOf: string) => daysBetween(asOf, today) > R.staleDays;
  const staleNote = (asOf: string) => `資料較舊（最新 ${asOf}），不拿來判斷`;

  const [inst, fx, oil, bond] = await Promise.all([
    safely('大盤法人', () => fetchMarketInstitutional(start)),
    safely('匯率', () => fetchExchangeRate('USD', start)),
    safely('原油', () => fetchCrudeOil('WTI', start)),
    safely('美債', () => fetchBondYield('United States 10-Year', start)),
  ]);
  const out: MacroIndicator[] = [];

  // 外資：外資及陸資 ＋ 外資自營商，買減賣
  if (inst instanceof Error) out.push(failed('foreign', '外資買賣超', inst));
  else {
    const byDate = new Map<string, number>();
    for (const r of inst) {
      if (r.name !== 'Foreign_Investor' && r.name !== 'Foreign_Dealer_Self') continue;
      byDate.set(r.date, (byDate.get(r.date) ?? 0) + (r.buy - r.sell));
    }
    const days = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-5);
    if (days.length === 0) out.push(failed('foreign', '外資買賣超', new Error('沒有資料')));
    else {
      const sum = days.reduce((s, [, v]) => s + v, 0) / 1e8;
      const [lastDate, lastNet] = days[days.length - 1];
      const stale = isStale(lastDate);
      const theme = sum >= R.foreignNet5d.buy ? 'foreign-buy' : sum <= R.foreignNet5d.sell ? 'foreign-sell' : null;
      out.push({
        key: 'foreign',
        label: '外資買賣超',
        asOf: lastDate,
        value: `近 ${days.length} 日 ${signed(sum)} 億`,
        change: `${lastDate.slice(5)} 單日 ${signed(lastNet / 1e8)} 億`,
        stale,
        note: stale ? staleNote(lastDate) : `${days[0][0].slice(5)}～${lastDate.slice(5)} 累計，門檻 ±${R.foreignNet5d.buy} 億`,
        trigger: !stale && theme ? { theme, tone: 1 } : null,
      });
    }
  }

  // 匯率：台銀即期買賣中價。美元兌台幣「上升」是台幣貶值
  if (fx instanceof Error) out.push(failed('usdtwd', '美元兌新台幣', fx));
  else {
    const rows = fx.filter((r) => r.spot_buy > 0 && r.spot_sell > 0).sort((a, b) => a.date.localeCompare(b.date));
    const pair = lastVsFiveBack(rows);
    if (!pair) out.push(failed('usdtwd', '美元兌新台幣', new Error('資料不足')));
    else {
      const mid = (r: (typeof rows)[number]) => (r.spot_buy + r.spot_sell) / 2;
      const [last, base] = pair;
      const pct = ((mid(last) - mid(base)) / mid(base)) * 100;
      const stale = isStale(last.date);
      const theme = pct <= -R.usdTwd5d.pct ? 'twd-up' : pct >= R.usdTwd5d.pct ? 'twd-down' : null;
      out.push({
        key: 'usdtwd',
        label: '美元兌新台幣',
        asOf: last.date,
        value: mid(last).toFixed(3),
        change: `近 5 筆 ${signed(pct, 2)}%（新台幣${pct < 0 ? '升值' : pct > 0 ? '貶值' : '持平'}）`,
        stale,
        note: stale ? staleNote(last.date) : `台銀即期中價，門檻 ±${R.usdTwd5d.pct}%`,
        trigger: !stale && theme ? { theme, tone: 1 } : null,
      });
    }
  }

  if (oil instanceof Error) out.push(failed('wti', 'WTI 原油', oil));
  else {
    const rows = oil.filter((r) => r.price > 0).sort((a, b) => a.date.localeCompare(b.date));
    const pair = lastVsFiveBack(rows);
    if (!pair) out.push(failed('wti', 'WTI 原油', new Error('資料不足')));
    else {
      const [last, base] = pair;
      const pct = ((last.price - base.price) / base.price) * 100;
      const stale = isStale(last.date);
      const tone = pct >= R.wti5d.pct ? 1 : pct <= -R.wti5d.pct ? -1 : 0;
      out.push({
        key: 'wti',
        label: 'WTI 原油',
        asOf: last.date,
        value: `${last.price.toFixed(2)} 美元`,
        change: `近 5 筆 ${signed(pct, 1)}%`,
        stale,
        note: stale ? staleNote(last.date) : `門檻 ±${R.wti5d.pct}%`,
        trigger: !stale && tone !== 0 ? { theme: 'oil', tone } : null,
      });
    }
  }

  if (bond instanceof Error) out.push(failed('us10y', '美債 10 年期殖利率', bond));
  else {
    const rows = bond.filter((r) => r.value > 0).sort((a, b) => a.date.localeCompare(b.date));
    const pair = lastVsFiveBack(rows);
    if (!pair) out.push(failed('us10y', '美債 10 年期殖利率', new Error('資料不足')));
    else {
      const [last, base] = pair;
      const delta = last.value - base.value;
      const stale = isStale(last.date);
      const tone = delta >= R.us10y5d.pts ? 1 : delta <= -R.us10y5d.pts ? -1 : 0;
      out.push({
        key: 'us10y',
        label: '美債 10 年期殖利率',
        asOf: last.date,
        value: `${last.value.toFixed(2)}%`,
        change: `近 5 筆 ${signed(delta, 2)} 個百分點`,
        stale,
        note: stale ? staleNote(last.date) : `門檻 ±${R.us10y5d.pts} 個百分點`,
        trigger: !stale && tone !== 0 ? { theme: 'us-yield', tone } : null,
      });
    }
  }

  return out;
}

// ── 組報告 ───────────────────────────────────────────────────────────

export interface CollectOptions {
  now: Date;
  /** 上一份報告的時間窗結尾。這次從那裡接著抓，不重複也不漏 */
  since: Date | null;
  /** stock 主檔的股號 → 股名，用來核對規則裡的個股 */
  stockNames: Map<string, string>;
}

export async function collectMacroReport({ now, since, stockNames }: CollectOptions): Promise<MacroPayload> {
  const windowTo = now;
  const windowFrom =
    since && now.getTime() - since.getTime() <= MAX_WINDOW_MS && since < now
      ? since
      : new Date(now.getTime() - DEFAULT_WINDOW_MS);

  const [{ sources, items }, indicators] = await Promise.all([collectNews(), collectIndicators(taipeiDate(now))]);

  // 去重：同標題留第一個有分類的來源（Yahoo 這種綜合來源排後面）
  const unique = new Map<string, RawItem>();
  for (const it of [...items].sort((a, b) => Number(a.feed.category === null) - Number(b.feed.category === null))) {
    const key = titleKey(it.title);
    if (!unique.has(key)) unique.set(key, it);
  }

  const inWindow = [...unique.entries()]
    .filter(([, it]) => it.publishedAt > windowFrom && it.publishedAt <= windowTo)
    .sort(([, a], [, b]) => b.publishedAt.getTime() - a.publishedAt.getTime());

  const allNews: MacroNews[] = inWindow.map(([key, it]) => ({
    id: createHash('sha1').update(key).digest('hex').slice(0, 10),
    title: it.title,
    link: it.link,
    source: it.source,
    feed: it.feed.id,
    publishedAt: it.publishedAt.toISOString(),
    category: it.feed.category,
    hits: matchThemes(it.title),
  }));

  // 核對規則裡的個股
  const warnings: string[] = [];
  const validStock = new Set<string>();
  for (const theme of THEMES) {
    for (const imp of theme.impacts) {
      const dbName = stockNames.get(imp.stockId);
      if (dbName && (dbName.includes(imp.name) || imp.name.includes(dbName))) validStock.add(imp.stockId);
      else {
        const w = `規則「${theme.label}」的 ${imp.stockId} ${imp.name}：${dbName ? `主檔股名是「${dbName}」` : '主檔沒有這個股號'}，已略過`;
        if (!warnings.includes(w)) warnings.push(w);
      }
    }
  }

  const themes: MacroThemeResult[] = [];
  for (const theme of THEMES) {
    const hits = allNews.flatMap((n) => n.hits.filter((h) => h.theme === theme.id).map((h) => ({ news: n, tone: h.tone })));
    const triggered = indicators.filter((i) => i.trigger?.theme === theme.id);
    if (hits.length === 0 && triggered.length === 0) continue;

    const positive = hits.filter((h) => h.tone === 1).length;
    const negative = hits.filter((h) => h.tone === -1).length;
    const score = positive - negative + triggered.reduce((s, i) => s + i.trigger!.tone * INDICATOR_WEIGHT, 0);
    const tone = Math.sign(score) as Tone;

    themes.push({
      id: theme.id,
      label: theme.label,
      category: theme.category,
      summary: theme.summary,
      tone,
      newsCount: hits.length,
      positive,
      negative,
      neutral: hits.length - positive - negative,
      // allNews 已經是新到舊，取前幾則就是最新的
      newsIds: hits.slice(0, EVIDENCE_PER_THEME).map((h) => h.news.id),
      indicatorKeys: triggered.map((i) => i.key),
      impacts: theme.impacts
        .filter((imp) => validStock.has(imp.stockId))
        .map((imp) => ({
          stockId: imp.stockId,
          stockName: stockNames.get(imp.stockId)!,
          effect: (imp.effect * tone) as Tone,
          horizon: imp.horizon,
          why: imp.why,
        })),
    });
  }
  const weight = (t: MacroThemeResult) => t.newsCount + t.indicatorKeys.length * INDICATOR_WEIGHT;
  themes.sort((a, b) => weight(b) - weight(a));

  // 存：各主題留下的證據，加上每類最多幾則沒對到主題的新聞
  const evidence = new Set(themes.flatMap((t) => t.newsIds));
  const perCategory = new Map<Category, number>();
  const stored = allNews.filter((n) => {
    if (evidence.has(n.id)) return true;
    if (n.hits.length > 0 || !n.category) return false;
    const c = perCategory.get(n.category) ?? 0;
    if (c >= OTHER_NEWS_PER_CATEGORY) return false;
    perCategory.set(n.category, c + 1);
    return true;
  });

  return {
    version: 1,
    windowFrom: windowFrom.toISOString(),
    windowTo: windowTo.toISOString(),
    sources,
    indicators,
    themes,
    news: stored,
    stats: {
      fetched: items.length,
      unique: unique.size,
      inWindow: allNews.length,
      matched: allNews.filter((n) => n.hits.length > 0).length,
      stored: stored.length,
    },
    warnings,
  };
}
