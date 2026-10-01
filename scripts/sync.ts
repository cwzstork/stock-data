/**
 * 每日同步：股票主檔 + 當日行情 + 股本 + 內部人持股
 *
 * 季頻財報不在這裡——它改由 backfill 的 quarterly 資料集負責。
 * 證交所給的是「累計」、FinMind 給的是「單季」，兩個來源寫進同一張表
 * 會變成一半累計一半單季，而且從欄位看不出來是哪一種。
 * 加上證交所那份在金控與保險業有欄位錯位的問題，FinMind 沒有，
 * 所以乾脆讓 FinMind 當唯一來源。
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
  fetchInsiderHoldings,
  fetchMonthlyRevenue,
  fetchTpexQuotes,
  fetchTpexValuation,
  fetchTwseQuotes,
  fetchTwseValuation,
  type DailyQuote,
  type InsiderHolding,
  type MonthlyRevenue,
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
  rows: { stockId: string; asOfDate: string; capital: string; issuedShares: string | null }[],
) {
  let n = 0;
  for (const part of chunks(rows)) {
    const [a, b, c, d] = columns(part, [
      (r) => r.stockId,
      (r) => r.asOfDate,
      (r) => r.capital,
      (r) => r.issuedShares,
    ]);
    n += await tx.$executeRawUnsafe(
      `INSERT INTO stock_capital (stock_id, report_date, capital, issued_shares)
       SELECT id, dt::date, cap::bigint, sh::bigint
         FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[]) AS x(id, dt, cap, sh)
       ON CONFLICT (stock_id, report_date) DO UPDATE SET
         capital = EXCLUDED.capital, issued_shares = EXCLUDED.issued_shares`,
      a,
      b,
      c,
      d,
    );
  }
  return n;
}

async function upsertInsider(tx: Tx, rows: InsiderHolding[]) {
  let n = 0;
  for (const part of chunks(rows)) {
    const c = columns(part, [
      (r) => r.stockId,
      (r) => r.periodEnd,
      (r) => r.directorShares,
      (r) => r.directorPledged,
      (r) => r.managerShares,
      (r) => r.majorShares,
    ]);
    n += await tx.$executeRawUnsafe(
      `INSERT INTO stock_insider (stock_id, period_end, director_shares, director_pledged,
                                  manager_shares, major_shares)
       SELECT id, pe::date, ds::bigint, dp::bigint, ms::bigint, js::bigint
         FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
              AS x(id, pe, ds, dp, ms, js)
       ON CONFLICT (stock_id, period_end) DO UPDATE SET
         director_shares = EXCLUDED.director_shares,
         director_pledged = EXCLUDED.director_pledged,
         manager_shares = EXCLUDED.manager_shares,
         major_shares = EXCLUDED.major_shares`,
      ...c,
    );
  }
  return n;
}

async function upsertRevenue(tx: Tx, rows: MonthlyRevenue[]) {
  let n = 0;
  for (const part of chunks(rows)) {
    const [a, b, c] = columns(part, [(r) => r.stockId, (r) => r.month, (r) => r.revenue]);
    n += await tx.$executeRawUnsafe(
      `INSERT INTO stock_revenue (stock_id, month, revenue)
       SELECT id, m::date, rev::bigint
         FROM UNNEST($1::text[], $2::text[], $3::text[]) AS x(id, m, rev)
       ON CONFLICT (stock_id, month) DO UPDATE SET revenue = EXCLUDED.revenue`,
      a,
      b,
      c,
    );
  }
  return n;
}

const COUNT_SQL = `SELECT 'stock' AS t, count(*) AS n FROM stock
   UNION ALL SELECT 'stock_daily', count(*) FROM stock_daily
   UNION ALL SELECT 'stock_capital', count(*) FROM stock_capital
   UNION ALL SELECT 'stock_quarterly', count(*) FROM stock_quarterly
   UNION ALL SELECT 'stock_insider', count(*) FROM stock_insider
   UNION ALL SELECT 'stock_revenue', count(*) FROM stock_revenue`;

async function main() {
  const t0 = Date.now();
  console.log(`\n=== 台股同步 ${COMMIT ? '【實際寫入】' : '【乾跑 DRY RUN，最後會 rollback】'} ===\n`);

  // ── 1. 抓資料 ───────────────────────────────────────────────
  console.log('[1/5] 抓取來源資料…');
  const [info, profiles, insiders, revenues, twseQ, twseV, tpexQ, tpexV, esbQ] = await Promise.all([
    fetchStockInfo(),
    fetchCompanyProfiles(),
    fetchInsiderHoldings(),
    fetchMonthlyRevenue(),
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
  console.log(`  內部人持股                     ${insiders.length} 筆`);
  console.log(`  月營收                         ${revenues.length} 筆`);

  // 某個市場回空就直接失敗，不要安靜地少寫一整個市場。
  //
  // 2026-09-30 的同步就踩到這個：上櫃 1,013 筆、興櫃 362 筆都正常寫進去，
  // 只有上市那一支回了空陣列。整個 job 還是綠燈，但資料庫裡那天的上市
  // 只有 329 檔（而且是歷史回補順手寫的，不是當天同步寫的），
  // 低於基準日的覆蓋度門檻，於是 2026-09-30 整天從下拉選單消失。
  //
  // 回空跟「今天沒開市」長得一樣，所以只有在「其他市場有資料」時才算異常——
  // 真正的休市日是三個市場同時回空。
  const feeds: [string, number][] = [
    ['上市行情', twseQ.length],
    ['上櫃行情', tpexQ.length],
    ['興櫃行情', esbQ.length],
  ];
  const empty = feeds.filter(([, c]) => c === 0);
  if (empty.length > 0 && empty.length < feeds.length) {
    throw new Error(
      `${empty.map(([name]) => name).join('、')}回傳空陣列，但其他市場有資料——` +
        `上游暫時出問題，這次不寫入，等下一輪重跑。` +
        `（${feeds.map(([name, c]) => `${name} ${c}`).join('　')}）`,
    );
  }
  if (empty.length === feeds.length) {
    console.log('  三個市場都沒有行情，今天應該沒有開市。不寫入。');
    return;
  }

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
  const latest = await prisma.$queryRawUnsafe<
    { stock_id: string; capital: string; issued_shares: string | null }[]
  >(
    `SELECT DISTINCT ON (stock_id) stock_id, capital::text AS capital,
            issued_shares::text AS issued_shares
       FROM stock_capital ORDER BY stock_id, report_date DESC`,
  );
  const latestCapital = new Map(latest.map((r) => [r.stock_id, r]));

  const capitalRows = profiles
    .filter((p) => p.capital !== null && known.has(p.stockId))
    .filter((p) => {
      const prev = latestCapital.get(p.stockId);
      // 股本沒變就不寫新列，否則每日同步會讓這張表跟日頻一樣大。
      // 但已發行股數是後來才加的欄位，既有列都是 NULL——
      // 只比對股本的話它們永遠補不到值，董監持股比例的分母就會一直是空的。
      return !prev || prev.capital !== p.capital || (prev.issued_shares === null && p.issuedShares !== null);
    })
    .map((p) => ({
      stockId: p.stockId,
      asOfDate: p.asOfDate,
      capital: p.capital as string,
      issuedShares: p.issuedShares,
    }));
  console.log(`  資料庫既有最新股本             ${latestCapital.size} 檔`);
  console.log(`  股本有變動需寫入               ${capitalRows.length} 筆`);

  // 內部人持股有外鍵指向 stock，主檔沒有的（少數公開發行但未上市櫃）要濾掉
  const insiderRows = insiders.filter((i) => known.has(i.stockId));
  const revenueRows = revenues.filter((r) => known.has(r.stockId));
  console.log(`  內部人可寫入                   ${insiderRows.length} 筆`);
  const months = [...new Set(revenueRows.map((r) => r.month))].sort();
  console.log(`  月營收可寫入                   ${revenueRows.length} 筆（月份 ${months.join(', ')}）`);

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
        const ins = await upsertInsider(tx, insiderRows);
        const rev = await upsertRevenue(tx, revenueRows);
        console.log(`  stock            寫入 ${s} 列`);
        console.log(`  stock_daily      寫入 ${d} 列`);
        console.log(`  stock_capital    寫入 ${c} 列`);
        console.log(`  stock_insider    寫入 ${ins} 列`);
        console.log(`  stock_revenue    寫入 ${rev} 列`);

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
