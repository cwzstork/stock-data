'use server';

import { createHash, timingSafeEqual } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { prisma } from './prisma';

/**
 * 刪除已匯出的宏觀事件報告。
 *
 * 網站沒有登入，server action 又可以被任何人直接 POST，所以一定要在這裡驗密碼，
 * 不能只靠畫面上藏按鈕。密碼放在 Vercel 的環境變數 MACRO_ADMIN_PASSWORD；
 * 沒設定時整個刪除功能停用（看與匯出不受影響）。
 */

export interface DeleteResult {
  ok: boolean;
  deleted: number;
  message: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 雜湊後再比，長度永遠相同，timingSafeEqual 才不會因為長度不同直接丟錯 */
function samePassword(a: string, b: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

export async function deleteMacroReports(input: {
  from: string;
  to: string;
  /** 匯出當下區間內最晚的產生時間。比它晚產生的（匯出後才被排程覆蓋的那天）不刪 */
  generatedMax: string;
  password: string;
}): Promise<DeleteResult> {
  const expected = process.env.MACRO_ADMIN_PASSWORD;
  if (!expected) {
    return { ok: false, deleted: 0, message: '刪除功能沒有啟用：Vercel 還沒設定 MACRO_ADMIN_PASSWORD。' };
  }
  if (!samePassword(String(input.password ?? ''), expected)) {
    // 拖慢一點，讓猜密碼不划算
    await new Promise((r) => setTimeout(r, 1_000));
    return { ok: false, deleted: 0, message: '密碼不對。' };
  }

  const { from, to, generatedMax } = input;
  if (!DATE.test(from) || !DATE.test(to) || from > to || Number.isNaN(Date.parse(generatedMax))) {
    return { ok: false, deleted: 0, message: '刪除範圍不正確，請重新匯出一次。' };
  }

  const deleted = await prisma.$executeRawUnsafe(
    `DELETE FROM macro_report
      WHERE report_date BETWEEN $1::date AND $2::date
        AND generated_at <= $3::timestamptz`,
    from,
    to,
    generatedMax,
  );
  revalidatePath('/macro');
  return { ok: true, deleted, message: `已刪除 ${deleted} 份（${from}～${to}）。` };
}
