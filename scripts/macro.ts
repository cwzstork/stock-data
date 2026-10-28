/**
 * 宏觀事件預覽：產生今天（台北日期）的報告，寫進 macro_report。
 *
 *   npm run macro               乾跑（預設）— 真的抓、真的 INSERT，最後 rollback
 *   npm run macro -- --commit   實際寫入
 *
 * 時間窗接在「前一天那份報告」的結尾後面，所以一天跑兩次只會讓當天的報告更完整，
 * 不會重複；同一天重跑是覆蓋，不會多一份。
 *
 * 規則與個股清單在 src/lib/macro-rules.ts，收集與比對在 src/lib/macro.ts。
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { collectMacroReport, taipeiDate } from '../src/lib/macro';
import { CATEGORIES, HORIZONS } from '../src/lib/macro-rules';

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

const TONE = { 1: '正向', [-1]: '反向', 0: '方向不明' } as const;
const EFFECT = { 1: '利多', [-1]: '利空', 0: '看新聞' } as const;

async function main() {
  const t0 = Date.now();
  const now = new Date();
  const reportDate = taipeiDate(now);
  console.log(`宏觀事件預覽 ${reportDate}（${COMMIT ? '寫入' : '乾跑'}）`);

  // 接在前一天那份後面。用 report_date < 今天，不是 <=：今天重跑時要從同一個起點重抓，
  // 拿今天自己的結尾當起點的話，第二輪只剩幾個小時的新聞，反而把早上那份蓋掉
  const prev = await prisma.$queryRawUnsafe<{ window_to: string | null }[]>(
    `SELECT payload->>'windowTo' AS window_to
       FROM macro_report WHERE report_date < $1::date
      ORDER BY report_date DESC LIMIT 1`,
    reportDate,
  );
  const since = prev[0]?.window_to ? new Date(prev[0].window_to) : null;

  const names = await prisma.$queryRawUnsafe<{ stock_id: string; stock_name: string }[]>(
    `SELECT stock_id, stock_name FROM stock`,
  );
  const stockNames = new Map(names.map((r) => [r.stock_id, r.stock_name]));

  const payload = await collectMacroReport({ now, since, stockNames });

  const ok = payload.sources.filter((s) => s.ok);
  console.log(`\n[來源] ${ok.length} / ${payload.sources.length} 個成功`);
  for (const s of payload.sources) {
    console.log(`  ${s.ok ? '✓' : '✗'} ${s.label.padEnd(24)} ${s.ok ? `${s.items} 則` : s.error}`);
  }
  console.log(`\n[時間窗] ${payload.windowFrom} ～ ${payload.windowTo}${since ? '（接前一份）' : '（往回 24 小時）'}`);
  const st = payload.stats;
  console.log(
    `[新聞] 抓到 ${st.fetched}、去重 ${st.unique}、時間窗內 ${st.inWindow}、對到主題 ${st.matched}、存 ${st.stored}`,
  );

  console.log('\n[指標]');
  for (const i of payload.indicators) {
    const trig = i.trigger ? `  → 觸發「${i.trigger.theme}」` : '';
    console.log(`  ${i.label.padEnd(10)} ${i.value}  ${i.change}  ${i.note}${trig}`);
  }

  console.log(`\n[主題] ${payload.themes.length} 個`);
  for (const t of payload.themes) {
    const ind = t.indicatorKeys.length ? ` ＋指標 ${t.indicatorKeys.join(',')}` : '';
    console.log(
      `  ${CATEGORIES[t.category]}｜${t.label}：${TONE[t.tone]}（新聞 ${t.newsCount} 則：正 ${t.positive}／反 ${t.negative}／不明 ${t.neutral}${ind}）`,
    );
    console.log(
      '    ' +
        t.impacts
          .map((i) => `${i.stockId}${i.stockName} ${EFFECT[i.effect]}·${HORIZONS[i.horizon].label}`)
          .join('、'),
    );
  }

  if (payload.warnings.length) {
    console.log(`\n[警告] ${payload.warnings.length} 則`);
    for (const w of payload.warnings) console.log(`  ${w}`);
  }

  // 一個來源都沒有就不寫：寫一份空報告會讓畫面看起來像「今天沒事」
  if (ok.length === 0) throw new Error('所有新聞來源都抓不到，不寫入');

  const json = JSON.stringify(payload);
  console.log(`\n[寫入] ${COMMIT ? '寫入資料庫…' : '在交易中試寫（之後回滾）…'}`);
  try {
    await prisma.$transaction(
      async (tx) => {
        const n = await tx.$executeRawUnsafe(
          `INSERT INTO macro_report (report_date, generated_at, payload)
           VALUES ($1::date, $2::timestamptz, $3::jsonb)
           ON CONFLICT (report_date) DO UPDATE SET
             generated_at = EXCLUDED.generated_at,
             payload      = EXCLUDED.payload`,
          reportDate,
          now.toISOString(),
          json,
        );
        console.log(`  macro_report     寫入 ${n} 列（${reportDate}，${(Buffer.byteLength(json) / 1024).toFixed(1)} KB）`);
        if (!COMMIT) throw new Rollback();
      },
      { maxWait: 30_000, timeout: 60_000 },
    );
    console.log('\n[OK] 已提交');
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log('\n[OK] 乾跑完成，交易已回滾');
  }

  const [{ n, mb }] = await prisma.$queryRawUnsafe<{ n: bigint; mb: string }[]>(
    `SELECT count(*) AS n, round(pg_total_relation_size('macro_report') / 1048576.0, 2)::text AS mb FROM macro_report`,
  );
  console.log(`macro_report 共 ${n} 份、${mb} MB`);
  console.log(`耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => {
    console.error('\n[FAIL] 宏觀事件預覽失敗:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
