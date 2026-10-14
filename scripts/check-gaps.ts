/**
 * 缺日偵測：把「證交所說該開市的日子」跟「資料庫實際落地的日子」對一遍。
 *
 * 為什麼需要這支：
 *   同步失敗會變紅燈，看得見；但「同步成功卻什麼有用的都沒寫」不會。
 *   STOCK_DAY_ALL 不吃日期參數，只給「最新一個交易日」。
 *   如果跑的時候證交所還沒出今天的報表，兩個市場會一致地給出昨天，
 *   守門不會擋（它只檢查上市與上櫃是不是同一天），於是昨天被原值覆寫一次、
 *   job 全綠，今天的行情就這樣沒了——2026-10-13 就是這樣掉的。
 *
 *   唯一靠得住的判準是「該有的交易日到底在不在資料庫裡」，而不是「同步有沒有報錯」。
 *
 * ── 兩個會誤報的坑 ──────────────────────────────────────────
 *
 * 1. 行事曆沒有颱風假。
 *    `fetchMarketHolidays()` 來源是預先公告的國定假日，不含當天才宣布的臨時休市。
 *    2026-07-10 就是這種：行事曆說它是交易日，但全市場一筆都沒有。
 *    所以看起來缺的日子不能直接判缺——要再帶日期去問證交所那天到底有沒有開市。
 *
 * 2. 歷史區本來就是稀疏的。
 *    `stock_daily` 的設計是「每月最後交易日 ＋ 近期逐日」，不是每天都留。
 *    稠密區從 2026-07-03 起算，再往前每天只有個位數檔（月底那天才是全市場）。
 *    視窗拉過 60 天就會掃進稀疏區，把設計當成缺漏。預設 30 天是為了這個。
 *
 * 除了整天 0 筆，也抓「有寫但寫不全」：2026-09-30 那次上市只有 329 檔，
 * 那天會因為涵蓋度不足被基準日下拉濾掉，等於也是沒有。
 * 門檻用當期中位數的一半，不寫死檔數——上市櫃家數本來就會變。
 *
 *   npm run check-gaps                 檢查近 30 天，有缺就 exit 1
 *   npm run check-gaps -- --days 90    拉長檢查範圍（會掃到稀疏區，見上）
 *   npm run check-gaps -- --warn       只印不失敗
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { fetchMarketHolidays, fetchTwseMarketOpen } from '../src/lib/twse';

try {
  process.loadEnvFile('.env');
} catch {
  // CI 由環境變數提供
}

const WARN_ONLY = process.argv.includes('--warn');
const DAYS = (() => {
  const i = process.argv.indexOf('--days');
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
})();

/** 台北是 UTC+8，runner 在 UTC，所有「今天是幾號」都要自己加回來 */
const TPE_OFFSET_MS = 8 * 60 * 60 * 1000;

function taipeiToday(): string {
  return new Date(Date.now() + TPE_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 某個交易日的行情何時算「該有了」。
 *
 * 證交所的日報表大約台北 15:00–16:00 才齊，留一小時緩衝取 17:00。
 * 台北 17:00 = 當天 09:00 UTC。
 *
 * 沒有這個緩衝的話，排在台北傍晚的那一輪會把「報表還沒出」誤判成「資料掉了」，
 * 每天都紅一次，紅燈就沒人看了。
 */
function dueAt(date: string): number {
  return Date.parse(`${date}T09:00:00Z`);
}

function* eachDay(from: string, to: string): Generator<string> {
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    yield new Date(t).toISOString().slice(0, 10);
  }
}

function dow(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

type Row = { dt: string; twse: number; tpex: number; total: number };

async function main() {
  const today = taipeiToday();
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  console.log(`缺日偵測  ${from} ~ ${today}（台北時間，共 ${DAYS} 天）\n`);
  if (DAYS > 60) {
    console.log(
      '  ! 視窗超過 60 天：stock_daily 的稠密區從 2026-07-03 起算，再往前是\n' +
        '    「每月最後交易日」的稀疏歷史（設計如此，不是缺漏），會被判成涵蓋不足。\n',
    );
  }

  const holidays = await fetchMarketHolidays();
  const closed = new Map(holidays.map((h) => [h.date, h.name]));
  // 行事曆只有當年度。查不到的年份一律「無法判定」，不要當成有開市。
  const coveredYears = new Set(holidays.map((h) => h.date.slice(0, 4)));
  console.log(
    `  行事曆：${holidays.length} 個休市日，涵蓋年度 ${[...coveredYears].sort().join('、')}`,
  );

  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT d.trade_date::text AS dt,
            count(*) FILTER (WHERE s.market = 'twse')::int AS twse,
            count(*) FILTER (WHERE s.market = 'tpex')::int AS tpex,
            count(*)::int                                  AS total
       FROM stock_daily d JOIN stock s USING (stock_id)
      WHERE d.trade_date BETWEEN $1::date AND $2::date
      GROUP BY 1`,
    from,
    today,
  );
  const have = new Map(rows.map((r) => [r.dt, r]));

  // 涵蓋度門檻：用當期實際中位數的一半，不寫死檔數
  const twseCounts = rows.map((r) => r.twse).filter((n) => n > 0).sort((a, b) => a - b);
  const median = twseCounts.length ? twseCounts[Math.floor(twseCounts.length / 2)] : 0;
  const floor = Math.floor(median / 2);
  console.log(`  上市檔數中位數 ${median}，涵蓋度門檻 ${floor}\n`);

  const missing: string[] = [];
  const thin: string[] = [];
  const pending: string[] = [];
  const unknown: string[] = [];
  const adhoc: string[] = [];
  const suspects: string[] = [];
  const line = new Map<string, string>();

  // ── 第一輪：先用行事曆與資料庫分類，不碰外部 API ──────────────
  for (const date of eachDay(from, today)) {
    const d = dow(date);
    if (d === 0 || d === 6) continue;

    const holiday = closed.get(date);
    if (holiday) {
      line.set(date, `休市（${holiday}）`);
      continue;
    }
    if (!coveredYears.has(date.slice(0, 4))) {
      line.set(date, '? 行事曆沒有這一年，無法判定');
      unknown.push(date);
      continue;
    }

    const row = have.get(date);
    if (!row || row.total === 0) {
      if (Date.now() < dueAt(date)) {
        line.set(date, '尚未到期（台北 17:00 後才該有）');
        pending.push(date);
      } else {
        // 先記下來，等一下逐一問證交所那天到底有沒有開市
        suspects.push(date);
      }
      continue;
    }
    if (row.twse < floor) {
      line.set(
        date,
        `涵蓋不足  上市 ${row.twse} / 門檻 ${floor}（上櫃 ${row.tpex}，合計 ${row.total}）`,
      );
      thin.push(date);
      continue;
    }
    line.set(date, `OK    上市 ${row.twse}  上櫃 ${row.tpex}  合計 ${row.total}`);
  }

  // ── 第二輪：可疑的日子才去問證交所，避免把颱風假當成掉資料 ────
  if (suspects.length) {
    console.log(`  有 ${suspects.length} 天看起來缺漏，逐一向證交所確認是否臨時休市…`);
    for (const date of suspects) {
      const open = await fetchTwseMarketOpen(date);
      if (open === false) {
        line.set(date, '臨時休市（證交所該日無資料，行事曆查不到，多半是颱風假）');
        adhoc.push(date);
      } else if (open === null) {
        line.set(date, '? 證交所問不到，無法判定是缺漏還是休市');
        unknown.push(date);
      } else {
        line.set(date, '缺漏  <-- 證交所那天有開市，資料庫卻一筆都沒有');
        missing.push(date);
      }
      await sleep(1200); // 這支是舊版報表，別打太快
    }
    console.log('');
  }

  console.log('日期         狀態');
  for (const date of eachDay(from, today)) {
    const text = line.get(date);
    if (text) console.log(`${date}   ${text}`);
  }

  const bad = missing.length + thin.length;
  console.log('');
  if (adhoc.length) console.log(`  臨時休市 ${adhoc.length} 天：${adhoc.join(', ')}`);
  if (unknown.length) console.log(`  無法判定 ${unknown.length} 天：${unknown.join(', ')}`);
  if (pending.length) console.log(`  尚未到期 ${pending.length} 天：${pending.join(', ')}`);

  if (bad === 0) {
    console.log('[OK] 該有的交易日都在，涵蓋度也正常');
    return;
  }

  if (missing.length) console.log(`  缺漏     ${missing.length} 天：${missing.join(', ')}`);
  if (thin.length) console.log(`  涵蓋不足 ${thin.length} 天：${thin.join(', ')}`);
  console.log(
    '\n  補救：STOCK_DAY_ALL 只給最新一個交易日，' +
      '所以只有在「下一個交易日收盤前」重跑同步才補得回來；' +
      '過了就要走 FinMind 逐檔（約 2,750 次呼叫）。',
  );

  if (WARN_ONLY) {
    console.log('\n[WARN] --warn 模式，不中斷');
    return;
  }
  throw new Error(`有 ${bad} 天的行情缺漏或涵蓋不足`);
}

main()
  .catch((e) => {
    console.error(`\n[FAIL] ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
