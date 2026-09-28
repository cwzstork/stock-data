/**
 * 每日同步：股票主檔 + 當日行情 + 股本
 *
 *   npm run sync               乾跑（預設）— 連得上資料庫、真的執行 SQL，但最後 rollback
 *   npm run sync -- --commit   實際寫入
 *
 * 乾跑不是「只印不做」：它會在交易裡把所有 INSERT 跑完、驗證型別與外鍵、
 * 回報實際落地的筆數，然後整筆回滾。這樣才驗得到寫入路徑真的沒問題。
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { fetchStockInfo } from '../src/lib/finmind';
import {
  fetchCompanyProfiles,
  fetchEmergingQuotes,
  fetchTpexQuotes,
  fetchTpexValuation,
  fetchTwseQuotes,
  fetchTwseValuation,
  type DailyQuote,
  type Valuation,
} from '../src/lib/twse';

try {
  process.loadEnvFile('.env');
} catch {
  // CI 由環境變數提供
}

const COMMIT = process.argv.includes('--commit');

class Rollback extends Error {
  constructor() {
    super('__dry_run_rollback__');
  }
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const CHUNK = 5_000;

function chunks<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 把欄位攤成 text[] 交給 UNNEST，再由 Postgres 轉型；避免 JS number 破壞精度 */
function columns<T>(rows: T[], pick: ((r: T) => string | null)[]): (string | null)[][] {
  return pick.map((f) => rows.map(f));
}

async function upsertStocks(
  tx: Tx,
  rows: { stockId: string; name: string; market: string; industry: string | null }[],
) {
  let n = 0;
  for (const part of chunks(rows)) {
    const [a, b, c, d] = columns(part, [
      (r) => r.stockId,
      (r) => r.name,
      (r) => r.market,
      (r) => r.industry,
    ]);
    n += await tx.$executeRawUnsafe(
      `INSERT INTO stock (stock_id, stock_name, market, industry_category, updated_at)
       SELECT id, nm, mk, ind, now()
         FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[]) AS x(id, nm, mk, ind)
       ON CONFLICT (stock_id) DO UPDATE SET
         stock_name        = EXCLUDED.stock_name,
         market            = EXCLUDED.market,
         industry_category = EXCLUDED.industry_category,
         updated_at        = now()`,
      a,
      b,
      c,
      d,
    );
  }
  return n;
}

async function upsertDaily(tx: Tx, rows: (DailyQuote & Partial<Valuation>)[]) {
  let n = 0;
  for (const part of chunks(rows)) {
    const cols = columns(part, [
      (r) => r.stockId,
      (r) => r.tradeDate,
      (r) => r.close,
      (r) => r.volume,
      (r) => r.turnover,
      (r) => r.dividendYield ?? null,
      (r) => r.per ?? null,
      (r) => r.pbr ?? null,
    ]);
    n += await tx.$executeRawUnsafe(
      `INSERT INTO stock_daily (stock_id, trade_date, close, volume, turnover, dividend_yield, per, pbr)
       SELECT id, dt::date, cl::numeric, vol::bigint, tv::bigint, dy::numeric, pe::numeric, pb::numeric
         FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
              AS x(id, dt, cl, vol, tv, dy, pe, pb)
       ON CONFLICT (stock_id, trade_date) DO UPDATE SET
         close          = EXCLUDED.close,
         volume         = EXCLUDED.volume,
         turnover       = EXCLUDED.turnover,
         dividend_yield = EXCLUDED.dividend_yield,
         per            = EXCLUDED.per,
         pbr            = EXCLUDED.pbr`,
      ...cols,
    );
  }
  return n;
}

async function upsertCapital(
  tx: Tx,
  rows: { stockId: string; asOfDate: string; capital: string }[],
) {
  let n = 0;
  for (const part of chunks(rows)) {
    const [a, b, c] = columns(part, [(r) => r.stockId, (r) => r.asOfDate, (r) => r.capital]);
    n += await tx.$executeRawUnsafe(
      `INSERT INTO stock_capital (stock_id, report_date, capital)
       SELECT id, dt::date, cap::bigint
         FROM UNNEST($1::text[], $2::text[], $3::text[]) AS x(id, dt, cap)
       ON CONFLICT (stock_id, report_date) DO UPDATE SET capital = EXCLUDED.capital`,
      a,
      b,
      c,
    );
  }
  return n;
}

const COUNT_SQL = `SELECT 'stock' AS t, count(*) AS n FROM stock
   UNION ALL SELECT 'stock_daily', count(*) FROM stock_daily
   UNION ALL SELECT 'stock_capital', count(*) FROM stock_capital`;

async function main() {
  const t0 = Date.now();
  console.log(`\n=== 台股同步 ${COMMIT ? '【實際寫入】' : '【乾跑 DRY RUN，最後會 rollback】'} ===\n`);

  // ── 1. 抓資料 ───────────────────────────────────────────────
  console.log('[1/5] 抓取來源資料…');
  const [info, profiles, twseQ, twseV, tpexQ, tpexV, esbQ] = await Promise.all([
    fetchStockInfo(),
    fetchCompanyProfiles(),
    fetchTwseQuotes(),
    fetchTwseValuation(),
    fetchTpexQuotes(),
    fetchTpexValuation(),
    fetchEmergingQuotes(),
  ]);
  console.log(`  主檔(FinMind)                  ${info.length} 檔`);
  console.log(`  公司基本資料                   ${profiles.length} 筆`);
  console.log(`  上市 行情/評價                 ${twseQ.length} / ${twseV.length}`);
  console.log(`  上櫃 行情/評價                 ${tpexQ.length} / ${tpexV.length}`);
  console.log(`  興櫃 行情                      ${esbQ.length}`);

  // ── 2. 合併行情與評價 ────────────────────────────────────────
  console.log('\n[2/5] 合併行情與評價…');
  const quotes = [...twseQ, ...tpexQ, ...esbQ];
  const dates = [...new Set(quotes.map((q) => q.tradeDate))].sort();
  if (dates.length !== 1) {
    console.warn(`  ! 三個市場的交易日不一致：${dates.join(', ')}（通常是某市場尚未更新）`);
  }
  console.log(`  交易日                         ${dates.join(' / ')}`);

  const valuation = new Map<string, Valuation>();
  for (const v of [...twseV, ...tpexV]) valuation.set(v.stockId, v);

  const known = new Map(info.map((r) => [r.stock_id, r]));
  const merged: (DailyQuote & Partial<Valuation>)[] = [];
  const seen = new Set<string>();
  let skippedUnknown = 0;
  for (const q of quotes) {
    if (!known.has(q.stockId)) {
      skippedUnknown += 1;
      continue;
    }
    if (seen.has(q.stockId)) continue; // 同一檔不應重複，保險
    seen.add(q.stockId);
    merged.push({ ...q, ...(valuation.get(q.stockId) ?? {}) });
  }
  console.log(`  可寫入日頻                     ${merged.length} 筆`);
  console.log(`  略過(主檔沒有，多為權證/債券)   ${skippedUnknown} 筆`);
  console.log(`  其中有收盤價                   ${merged.filter((m) => m.close != null).length} 筆`);
  console.log(`  其中有殖利率                   ${merged.filter((m) => m.dividendYield != null).length} 筆`);

  // ── 3. 股本：只在數值變動時才寫新的一筆 ──────────────────────
  console.log('\n[3/5] 比對股本…');
  const latest = await prisma.$queryRawUnsafe<{ stock_id: string; capital: string }[]>(
    `SELECT DISTINCT ON (stock_id) stock_id, capital::text AS capital
       FROM stock_capital ORDER BY stock_id, report_date DESC`,
  );
  const latestCapital = new Map(latest.map((r) => [r.stock_id, r.capital]));

  const capitalRows = profiles
    .filter((p) => p.capital !== null && known.has(p.stockId))
    .filter((p) => latestCapital.get(p.stockId) !== p.capital)
    .map((p) => ({ stockId: p.stockId, asOfDate: p.asOfDate, capital: p.capital as string }));
  console.log(`  資料庫既有最新股本             ${latestCapital.size} 檔`);
  console.log(`  股本有變動需寫入               ${capitalRows.length} 筆`);

  // ── 4. 主檔 ─────────────────────────────────────────────────
  const stockRows = info.map((r) => ({
    stockId: r.stock_id,
    name: r.stock_name,
    market: r.type,
    industry: r.industry_category || null,
  }));

  console.log('\n[4/5] 樣本檢查（台積電 2330）');
  console.log('  主檔  ', JSON.stringify(stockRows.find((s) => s.stockId === '2330')));
  console.log('  日頻  ', JSON.stringify(merged.find((m) => m.stockId === '2330')));
  console.log('  股本  ', JSON.stringify(profiles.find((p) => p.stockId === '2330')));

  // ── 5. 寫入（乾跑時回滾）─────────────────────────────────────
  console.log(`\n[5/5] ${COMMIT ? '寫入資料庫…' : '在交易中試寫（之後回滾）…'}`);
  try {
    await prisma.$transaction(
      async (tx) => {
        const s = await upsertStocks(tx, stockRows);
        const d = await upsertDaily(tx, merged);
        const c = await upsertCapital(tx, capitalRows);
        console.log(`  stock          寫入 ${s} 列`);
        console.log(`  stock_daily    寫入 ${d} 列`);
        console.log(`  stock_capital  寫入 ${c} 列`);

        const inTx = await tx.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_SQL);
        console.log('  交易內表列數：', inTx.map((r) => `${r.t}=${r.n}`).join('  '));

        if (!COMMIT) throw new Rollback();
      },
      { maxWait: 30_000, timeout: 300_000 },
    );
    console.log('\n[OK] 已提交');
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log('\n[OK] 乾跑完成，交易已回滾');
  }

  // 回滾後再查一次，證明資料庫真的沒被動到
  const after = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_SQL);
  console.log('交易外表列數：', after.map((r) => `${r.t}=${r.n}`).join('  '));
  console.log(`\n耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => {
    console.error('\n[FAIL] 同步失敗:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
