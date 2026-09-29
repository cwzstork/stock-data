/**
 * 逐檔歷史回補。
 *
 *   npm run backfill                        乾跑（預設）：只抓幾檔看資料對不對，不寫入
 *   npm run backfill -- --commit            實際寫入，自動挑還沒補完的資料集
 *   npm run backfill -- --commit --dataset=annual
 *   npm run backfill -- --commit '--stocks=2330,0056'
 *
 * 為什麼逐檔：
 *   FinMind 免費層擋掉「不帶 data_id 的全市場查詢」，
 *   但帶 data_id 時一次呼叫就拿到該檔十年份，所以逐檔其實很划算。
 *
 * 為什麼要能續跑：
 *   三千多檔、每小時 600 次的額度，一次跑不完。
 *   進度記在 backfill_log，沒有它的話「本來就沒資料的公司」會每次被重抓。
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  fetchDividends,
  fetchPerHistory,
  fetchPriceHistory,
  type DividendRow,
  type PerRow,
  type PriceRow,
} from '../src/lib/finmind';
import { readR2Config, uploadDailyParquet } from '../src/lib/parquet';

try {
  process.loadEnvFile('.env');
} catch {
  // CI 由環境變數提供
}

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

/** 從哪一年開始補。算 10 年平均要再往前一點，多抓一年當緩衝 */
const START_DATE = flag('start') ?? '2015-01-01';

/**
 * 指定股票代號，逗號分隔。
 *
 * 在 PowerShell 一定要加引號：
 *     npm run backfill -- '--stocks=2330,0056,00878'      對
 *     npm run backfill -- --stocks=2330,0056,00878        錯
 * 不加引號時 PowerShell 會把逗號串當成陣列、把 0056 當數字，
 * 實際傳進來的會變成「2330,56,878」。這不會報錯，只會安靜地查錯股票，
 * 而台股 ETF 代號全靠前導零（0050 / 0056 / 00878）。
 */
const ONLY = flag('stocks')?.split(',').map((s) => s.trim()).filter(Boolean);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 工具 ──────────────────────────────────────────────────────────

/** 一批陣列攤成 text[] 交給 UNNEST，型別由 Postgres 轉，避免 JS number 破壞精度 */
function cols<T>(rows: T[], pick: ((r: T) => string | null)[]): (string | null)[][] {
  return pick.map((f) => rows.map(f));
}

const num = (v: number | null | undefined): string | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : String(v);

/** 平均。空陣列回 null，不要回 0——0 的意思完全不同 */
const avg = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

// ── 資料集：配息 ──────────────────────────────────────────────────

interface DivRow {
  stockId: string;
  exDate: string;
  cash: string;
  stockDiv: string;
  payDate: string | null;
  period: string | null;
}

/**
 * 一列原始紀錄 → 一次除息。
 * 沒有除息（權）日的是「已公告但尚未除息」，還不算真的配發過，納入會讓殖利率虛增。
 */
function normalizeDividend(stockId: string, r: DividendRow): DivRow | null {
  const exDate = r.CashExDividendTradingDate || r.StockExDividendTradingDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate ?? '')) return null;
  const cash = (r.CashEarningsDistribution ?? 0) + (r.CashStatutorySurplus ?? 0);
  const stockDiv = (r.StockEarningsDistribution ?? 0) + (r.StockStatutorySurplus ?? 0);
  if (cash <= 0 && stockDiv <= 0) return null;
  return {
    stockId,
    exDate,
    cash: cash.toFixed(6),
    stockDiv: stockDiv.toFixed(6),
    payDate: /^\d{4}-\d{2}-\d{2}$/.test(r.CashDividendPaymentDate) ? r.CashDividendPaymentDate : null,
    period: r.year || null,
  };
}

/**
 * 同一個除息日出現多列時的處理。
 *
 * 上游會有重複列：00878 的 2023-08-16 出現兩次，金額與發放日完全相同，
 * 只有 date 欄位不一樣。這種要去重，不能加總——加總會讓那次配息變成兩倍。
 * 金額不同理論上不該發生，真的遇到就取最後一筆並回報，不要安靜地選一個。
 */
function dedupe(rows: DivRow[]): { rows: DivRow[]; dropped: number; conflicts: string[] } {
  const byDate = new Map<string, DivRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.exDate);
    if (list) list.push(r);
    else byDate.set(r.exDate, [r]);
  }
  const out: DivRow[] = [];
  const conflicts: string[] = [];
  let dropped = 0;
  for (const [exDate, list] of byDate) {
    if (list.length > 1) {
      dropped += list.length - 1;
      if (new Set(list.map((r) => `${r.cash}|${r.stockDiv}`)).size > 1) {
        conflicts.push(exDate);
      }
    }
    out.push(list[list.length - 1]);
  }
  out.sort((a, b) => a.exDate.localeCompare(b.exDate));
  return { rows: out, dropped, conflicts };
}

async function runDividend(stockId: string) {
  const raw = await fetchDividends(stockId, START_DATE);
  const { rows, dropped, conflicts } = dedupe(
    raw.map((r) => normalizeDividend(stockId, r)).filter((r): r is DivRow => r !== null),
  );
  if (!COMMIT || rows.length === 0) return { rows: rows.length, dropped, conflicts, note: '' };

  const c = cols(rows, [
    (r) => r.stockId,
    (r) => r.exDate,
    (r) => r.cash,
    (r) => r.stockDiv,
    (r) => r.payDate,
    (r) => r.period,
  ]);
  await prisma.$executeRawUnsafe(
    `INSERT INTO stock_dividend (stock_id, ex_date, cash, stock_div, pay_date, period)
     SELECT id, ex::date, ca::numeric, sd::numeric, pd::date, p
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
            AS x(id, ex, ca, sd, pd, p)
     ON CONFLICT (stock_id, ex_date) DO UPDATE SET
       cash = EXCLUDED.cash, stock_div = EXCLUDED.stock_div,
       pay_date = EXCLUDED.pay_date, period = EXCLUDED.period`,
    ...c,
  );
  const last = rows[rows.length - 1];
  return {
    rows: rows.length,
    dropped,
    conflicts,
    note: `最近除息 ${last.exDate} 現金 ${Number(last.cash).toFixed(4)}`,
  };
}

// ── 資料集：年度彙總 ──────────────────────────────────────────────

interface AnnualRow {
  stockId: string;
  year: string;
  avgClose: string | null;
  high: string | null;
  low: string | null;
  lastClose: string | null;
  days: string;
  avgPer: string | null;
  minPer: string | null;
  avgPbr: string | null;
  minPbr: string | null;
  avgYield: string | null;
  maxYield: string | null;
}

/**
 * 日頻 → 年度彙總。
 *
 * 本益比／股價淨值比在虧損或無資料時，上游會給 0 或 null。
 * 0 不能當成「最便宜」——那是「沒有意義」，所以一律濾掉非正數，
 * 否則「近 N 年最低本益比」會全部變成 0。
 */
function aggregate(stockId: string, prices: PriceRow[], pers: PerRow[]): AnnualRow[] {
  const byYear = new Map<
    string,
    { close: number[]; high: number[]; low: number[]; last: { d: string; c: number } | null }
  >();
  for (const p of prices) {
    const y = p.date.slice(0, 4);
    const g = byYear.get(y) ?? { close: [], high: [], low: [], last: null };
    if (Number.isFinite(p.close) && p.close > 0) {
      g.close.push(p.close);
      if (!g.last || p.date > g.last.d) g.last = { d: p.date, c: p.close };
    }
    if (Number.isFinite(p.max) && p.max > 0) g.high.push(p.max);
    if (Number.isFinite(p.min) && p.min > 0) g.low.push(p.min);
    byYear.set(y, g);
  }

  const perByYear = new Map<string, { per: number[]; pbr: number[]; yld: number[] }>();
  for (const p of pers) {
    const y = p.date.slice(0, 4);
    const g = perByYear.get(y) ?? { per: [], pbr: [], yld: [] };
    if (p.PER != null && p.PER > 0) g.per.push(p.PER);
    if (p.PBR != null && p.PBR > 0) g.pbr.push(p.PBR);
    if (p.dividend_yield != null && p.dividend_yield > 0) g.yld.push(p.dividend_yield);
    perByYear.set(y, g);
  }

  const out: AnnualRow[] = [];
  for (const [year, g] of [...byYear].sort(([a], [b]) => a.localeCompare(b))) {
    if (g.close.length === 0) continue;
    const v = perByYear.get(year) ?? { per: [], pbr: [], yld: [] };
    out.push({
      stockId,
      year,
      avgClose: num(avg(g.close)),
      high: num(g.high.length ? Math.max(...g.high) : null),
      low: num(g.low.length ? Math.min(...g.low) : null),
      lastClose: num(g.last?.c ?? null),
      days: String(g.close.length),
      avgPer: num(avg(v.per)),
      minPer: num(v.per.length ? Math.min(...v.per) : null),
      avgPbr: num(avg(v.pbr)),
      minPbr: num(v.pbr.length ? Math.min(...v.pbr) : null),
      avgYield: num(avg(v.yld)),
      maxYield: num(v.yld.length ? Math.max(...v.yld) : null),
    });
  }
  return out;
}

// 沒設定 R2 就是 null，整段外存會安靜跳過
const R2 = readR2Config();

async function runAnnual(stockId: string) {
  const prices = await fetchPriceHistory(stockId, START_DATE);
  await sleep(CALL_GAP_MS);
  // ETF 與興櫃沒有評價資料，這支會回空陣列，不算錯誤
  const pers = await fetchPerHistory(stockId, START_DATE);

  const rows = aggregate(stockId, prices, pers);
  if (!COMMIT || rows.length === 0) return { rows: rows.length, dropped: 0, conflicts: [], note: '' };

  // 日頻明細順手外存。這裡不用多打任何一次 API——prices 本來就抓進來了，
  // 只是彙總完就丟掉太可惜，而它進資料庫會撞爆免費層容量。
  let parquetNote = '';
  if (R2 && prices.length) {
    try {
      const up = await uploadDailyParquet(R2, stockId, prices);
      parquetNote = `  parquet ${up.rows} 列`;
    } catch (e) {
      // 外存失敗不該讓年度彙總跟著失敗，那才是主要產出
      console.warn(`      ! ${stockId} Parquet 外存失敗: ${e instanceof Error ? e.message : e}`);
    }
  }

  const c = cols(rows, [
    (r) => r.stockId,
    (r) => r.year,
    (r) => r.avgClose,
    (r) => r.high,
    (r) => r.low,
    (r) => r.lastClose,
    (r) => r.days,
    (r) => r.avgPer,
    (r) => r.minPer,
    (r) => r.avgPbr,
    (r) => r.minPbr,
    (r) => r.avgYield,
    (r) => r.maxYield,
  ]);
  await prisma.$executeRawUnsafe(
    `INSERT INTO stock_annual (stock_id, year, avg_close, high, low, last_close, days,
                               avg_per, min_per, avg_pbr, min_pbr, avg_yield, max_yield)
     SELECT id, y::int, ac::numeric, hi::numeric, lo::numeric, lc::numeric, dy::int,
            ap::numeric, mp::numeric, apb::numeric, mpb::numeric, ay::numeric, my::numeric
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[])
            AS x(id, y, ac, hi, lo, lc, dy, ap, mp, apb, mpb, ay, my)
     ON CONFLICT (stock_id, year) DO UPDATE SET
       avg_close = EXCLUDED.avg_close, high = EXCLUDED.high, low = EXCLUDED.low,
       last_close = EXCLUDED.last_close, days = EXCLUDED.days,
       avg_per = EXCLUDED.avg_per, min_per = EXCLUDED.min_per,
       avg_pbr = EXCLUDED.avg_pbr, min_pbr = EXCLUDED.min_pbr,
       avg_yield = EXCLUDED.avg_yield, max_yield = EXCLUDED.max_yield`,
    ...c,
  );
  const last = rows[rows.length - 1];
  return {
    rows: rows.length,
    dropped: 0,
    conflicts: [],
    note: `${rows[0].year}~${last.year} 最新年均價 ${Number(last.avgClose).toFixed(2)}${parquetNote}`,
  };
}

// ── 資料集登記 ────────────────────────────────────────────────────

interface Dataset {
  key: string;
  label: string;
  /** 每檔要打幾次 API，用來換算節流間隔 */
  calls: number;
  run: (stockId: string) => Promise<{ rows: number; dropped: number; conflicts: string[]; note: string }>;
}

const DATASETS: Dataset[] = [
  { key: 'dividend', label: '配息紀錄', calls: 1, run: runDividend },
  { key: 'annual', label: '年度彙總', calls: 2, run: runAnnual },
];

/** FinMind register 層的文件額度是 600 次/小時，留一點餘裕給每日同步 */
const CALLS_PER_HOUR = Number(flag('rate') ?? 560);
/** 同一檔內連續兩次呼叫之間的間隔 */
const CALL_GAP_MS = Math.round(3_600_000 / CALLS_PER_HOUR);

/** 已經補過的檔多久之後才重抓 */
const REFRESH_DAYS = Number(flag('refresh') ?? 30);

async function pickTargets(ds: Dataset, limit: number) {
  if (ONLY?.length) {
    return prisma.$queryRawUnsafe<{ stock_id: string; stock_name: string }[]>(
      `SELECT stock_id, stock_name FROM stock WHERE stock_id = ANY($1::text[]) ORDER BY stock_id`,
      ONLY,
    );
  }
  return prisma.$queryRawUnsafe<{ stock_id: string; stock_name: string }[]>(
    `SELECT s.stock_id, s.stock_name
       FROM stock s
       LEFT JOIN backfill_log b ON b.stock_id = s.stock_id AND b.dataset = $1
      WHERE b.stock_id IS NULL OR b.synced_at < now() - ($2 || ' days')::interval
      ORDER BY b.synced_at NULLS FIRST, s.stock_id
      LIMIT $3`,
    ds.key,
    String(REFRESH_DAYS),
    limit,
  );
}

async function progress(key: string) {
  const [r] = await prisma.$queryRawUnsafe<{ total: number; done: number }[]>(
    `SELECT (SELECT count(*)::int FROM stock) AS total,
            (SELECT count(*)::int FROM backfill_log WHERE dataset = $1) AS done`,
    key,
  );
  return r;
}

async function main() {
  const t0 = Date.now();

  // 沒指定就挑第一個還沒補完的資料集：配息優先，再來年度彙總
  let ds = DATASETS.find((d) => d.key === flag('dataset'));
  if (!ds) {
    for (const cand of DATASETS) {
      const p = await progress(cand.key);
      if (p.done < p.total) {
        ds = cand;
        break;
      }
    }
  }
  if (!ds) {
    console.log('所有資料集都補完了。');
    return;
  }

  const limit = Number(flag('limit') ?? (COMMIT ? Math.floor(CALLS_PER_HOUR / ds.calls) : 3));
  const itemGap = CALL_GAP_MS * ds.calls;

  console.log(`\n=== 回補「${ds.label}」 ${COMMIT ? '【實際寫入】' : '【乾跑 DRY RUN】'} ===`);
  console.log(
    `起始 ${START_DATE}　本次上限 ${limit} 檔　每檔 ${ds.calls} 次呼叫　間隔 ${(itemGap / 1000).toFixed(1)}s`,
  );
  const p0 = await progress(ds.key);
  console.log(`整體進度 ${p0.done} / ${p0.total}`);
  if (ds.key === 'annual') {
    console.log(R2 ? `日頻明細外存 R2：${R2.bucket}/${R2.prefix}/` : '日頻明細外存：未設定 R2，略過');
  }
  console.log('');

  const targets = await pickTargets(ds, limit);
  if (targets.length === 0) {
    console.log('沒有待處理的股票。');
    return;
  }

  let ok = 0;
  let empty = 0;
  let failed = 0;
  let dropped = 0;

  for (const [i, t] of targets.entries()) {
    if (i > 0) await sleep(itemGap);
    try {
      const r = await ds.run(t.stock_id);
      dropped += r.dropped;
      if (r.conflicts.length) {
        console.warn(`      ! ${t.stock_id} 同一日期資料不一致: ${r.conflicts.join(', ')}`);
      }
      if (COMMIT) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO backfill_log (stock_id, dataset, synced_at, rows) VALUES ($1,$2,now(),$3)
           ON CONFLICT (stock_id, dataset) DO UPDATE SET synced_at = now(), rows = EXCLUDED.rows`,
          t.stock_id,
          ds.key,
          r.rows,
        );
      }
      if (r.rows === 0) empty += 1;
      else ok += 1;

      const pct = (((i + 1) / targets.length) * 100).toFixed(0);
      console.log(
        `  [${String(i + 1).padStart(4)}/${targets.length} ${pct.padStart(3)}%] ` +
          `${t.stock_id.padEnd(7)} ${String(t.stock_name).padEnd(12)} ${String(r.rows).padStart(4)} 列  ${r.note}`,
      );
    } catch (e) {
      failed += 1;
      // 失敗不記進度，下次會重試
      console.error(`  [${i + 1}/${targets.length}] ${t.stock_id} 失敗:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(
    `\n本次：有資料 ${ok}　無資料 ${empty}　失敗 ${failed}` + (dropped ? `　去除重複列 ${dropped}` : ''),
  );
  if (!COMMIT) console.log('（乾跑，沒有寫入也沒有記錄進度）');

  const p1 = await progress(ds.key);
  console.log(
    `整體進度 ${p1.done} / ${p1.total}${p1.done < p1.total ? `　還差 ${p1.total - p1.done} 檔` : '　已完成'}`,
  );
  console.log(`耗時 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分鐘`);
}

main()
  .catch((e) => {
    console.error('\n[FAIL] 回補失敗:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
