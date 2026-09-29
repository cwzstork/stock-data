/**
 * 逐檔歷史回補。
 *
 *   npm run backfill                    乾跑（預設）：只抓前幾檔看資料對不對，不寫入
 *   npm run backfill -- --commit        實際寫入
 *   npm run backfill -- --commit --limit=550
 *   npm run backfill -- --commit --stocks=2330,0056
 *
 * 為什麼要逐檔：
 *   FinMind 免費層（register）擋掉「不帶 data_id 的全市場查詢」，
 *   但帶 data_id 時，一次呼叫就能拿該檔十年份，所以逐檔其實很划算。
 *
 * 為什麼要能續跑：
 *   三千多檔、每小時 600 次的額度，一次跑不完。
 *   進度記在 backfill_log，沒有它的話「本來就沒配過息的公司」會每次都被重抓。
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { fetchDividends } from '../src/lib/finmind';

try {
  process.loadEnvFile('.env');
} catch {
  // CI 由環境變數提供
}

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

/** 從哪一年開始補。要算 10 年平均殖利率就得再往前一點，多抓一年當緩衝 */
const START_DATE = flag('start') ?? '2015-01-01';

/**
 * 每次執行處理幾檔。
 * FinMind register 層的文件額度是 600 次/小時，留 50 次餘裕給每日同步用。
 */
const LIMIT = Number(flag('limit') ?? (COMMIT ? 550 : 5));

/** 相鄰兩次請求的間隔。600 次/小時 = 6 秒一次。 */
const INTERVAL_MS = Number(flag('interval') ?? 6_000);

/** 已經補過的檔多久之後才重抓。配息一年才變幾次，不用太勤。 */
const REFRESH_DAYS = Number(flag('refresh') ?? 30);

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

const DATASET = 'dividend';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Normalized {
  stockId: string;
  exDate: string;
  cash: string;
  stockDiv: string;
  payDate: string | null;
  period: string | null;
}

/**
 * 一列原始紀錄 → 一次除息。
 *
 * 沒有除息（權）日的列是「已公告但尚未除息」，
 * 它還不算真的配發過，納入會讓殖利率虛增，所以跳過。
 */
function normalize(stockId: string, r: Awaited<ReturnType<typeof fetchDividends>>[number]): Normalized | null {
  const exDate = r.CashExDividendTradingDate || r.StockExDividendTradingDate;
  if (!exDate || !/^\d{4}-\d{2}-\d{2}$/.test(exDate)) return null;

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
 *
 * 金額不同的情況理論上不該發生（同一天不會配兩次不同的錢），
 * 真的遇到就取最後一筆並回報，不要安靜地選一個。
 */
function dedupe(rows: Normalized[]): { rows: Normalized[]; dropped: number; conflicts: string[] } {
  const byDate = new Map<string, Normalized[]>();
  for (const r of rows) {
    const list = byDate.get(r.exDate);
    if (list) list.push(r);
    else byDate.set(r.exDate, [r]);
  }

  const out: Normalized[] = [];
  const conflicts: string[] = [];
  let dropped = 0;

  for (const [exDate, list] of byDate) {
    if (list.length > 1) {
      dropped += list.length - 1;
      const distinct = new Set(list.map((r) => `${r.cash}|${r.stockDiv}`));
      if (distinct.size > 1) conflicts.push(`${exDate}(${[...distinct].join(' vs ')})`);
    }
    out.push(list[list.length - 1]);
  }

  out.sort((a, b) => a.exDate.localeCompare(b.exDate));
  return { rows: out, dropped, conflicts };
}

async function writeDividends(rows: Normalized[]) {
  if (rows.length === 0) return 0;
  const col = (f: (r: Normalized) => string | null) => rows.map(f);
  return prisma.$executeRawUnsafe(
    `INSERT INTO stock_dividend (stock_id, ex_date, cash, stock_div, pay_date, period)
     SELECT id, ex::date, c::numeric, sd::numeric, pd::date, p
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
            AS x(id, ex, c, sd, pd, p)
     ON CONFLICT (stock_id, ex_date) DO UPDATE SET
       cash = EXCLUDED.cash, stock_div = EXCLUDED.stock_div,
       pay_date = EXCLUDED.pay_date, period = EXCLUDED.period`,
    col((r) => r.stockId),
    col((r) => r.exDate),
    col((r) => r.cash),
    col((r) => r.stockDiv),
    col((r) => r.payDate),
    col((r) => r.period),
  );
}

async function markDone(stockId: string, rows: number) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO backfill_log (stock_id, dataset, synced_at, rows)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (stock_id, dataset) DO UPDATE SET synced_at = now(), rows = EXCLUDED.rows`,
    stockId,
    DATASET,
    rows,
  );
}

/** 還沒補過的優先，其次是補過但已經過期的 */
async function pickTargets(): Promise<{ stock_id: string; stock_name: string }[]> {
  if (ONLY?.length) {
    return prisma.$queryRawUnsafe(
      `SELECT stock_id, stock_name FROM stock WHERE stock_id = ANY($1::text[]) ORDER BY stock_id`,
      ONLY,
    );
  }
  return prisma.$queryRawUnsafe(
    `SELECT s.stock_id, s.stock_name
       FROM stock s
       LEFT JOIN backfill_log b ON b.stock_id = s.stock_id AND b.dataset = $1
      WHERE b.stock_id IS NULL
         OR b.synced_at < now() - ($2 || ' days')::interval
      ORDER BY b.synced_at NULLS FIRST, s.stock_id
      LIMIT $3`,
    DATASET,
    String(REFRESH_DAYS),
    LIMIT,
  );
}

async function main() {
  const t0 = Date.now();
  console.log(`\n=== 配息回補 ${COMMIT ? '【實際寫入】' : '【乾跑 DRY RUN】'} ===`);
  console.log(`起始日期 ${START_DATE}   本次上限 ${LIMIT} 檔   間隔 ${INTERVAL_MS / 1000}s`);

  const [{ total, done }] = await prisma.$queryRawUnsafe<{ total: number; done: number }[]>(
    `SELECT (SELECT count(*)::int FROM stock) AS total,
            (SELECT count(*)::int FROM backfill_log WHERE dataset = $1) AS done`,
    DATASET,
  );
  console.log(`整體進度 ${done} / ${total}\n`);

  const targets = await pickTargets();
  if (targets.length === 0) {
    console.log('沒有待處理的股票，全部補完了。');
    return;
  }

  let ok = 0;
  let empty = 0;
  let failed = 0;
  let written = 0;
  let totalDropped = 0;

  for (const [i, t] of targets.entries()) {
    if (i > 0) await sleep(INTERVAL_MS);
    try {
      const raw = await fetchDividends(t.stock_id, START_DATE);
      const { rows, dropped, conflicts } = dedupe(
        raw.map((r) => normalize(t.stock_id, r)).filter((r): r is Normalized => r !== null),
      );
      totalDropped += dropped;
      if (conflicts.length) {
        console.warn(`      ! ${t.stock_id} 同一除息日金額不一致: ${conflicts.join(', ')}`);
      }

      if (COMMIT) {
        written += await writeDividends(rows);
        await markDone(t.stock_id, rows.length);
      }

      if (rows.length === 0) empty += 1;
      else ok += 1;

      const pct = (((i + 1) / targets.length) * 100).toFixed(0);
      console.log(
        `  [${String(i + 1).padStart(4)}/${targets.length}  ${pct.padStart(3)}%] ` +
          `${t.stock_id.padEnd(7)} ${String(t.stock_name).padEnd(12)} ` +
          `原始 ${String(raw.length).padStart(3)} → 有效 ${String(rows.length).padStart(3)}` +
          (rows.length ? `  最近除息 ${rows.at(-1)!.exDate} 現金 ${Number(rows.at(-1)!.cash).toFixed(4)}` : ''),
      );
    } catch (e) {
      failed += 1;
      console.error(`  [${i + 1}/${targets.length}] ${t.stock_id} 失敗:`, e instanceof Error ? e.message : e);
      // 失敗不記進度，下次會重試
    }
  }

  console.log(
    `\n本次：有配息 ${ok}　無配息 ${empty}　失敗 ${failed}　寫入 ${written} 列` +
      (totalDropped ? `　去除上游重複列 ${totalDropped}` : ''),
  );
  if (!COMMIT) console.log('（乾跑，沒有寫入也沒有記錄進度）');

  const [{ done: done2 }] = await prisma.$queryRawUnsafe<{ done: number }[]>(
    `SELECT count(*)::int AS done FROM backfill_log WHERE dataset = $1`,
    DATASET,
  );
  console.log(`整體進度 ${done2} / ${total}${done2 < total ? `　還差 ${total - done2} 檔` : '　已完成'}`);
  console.log(`耗時 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分鐘`);
}

main()
  .catch((e) => {
    console.error('\n[FAIL] 回補失敗:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
