'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

/**
 * 全站共用的頂部導覽。
 *
 * 為什麼不用各頁自己放「← 回篩選器」這種文字連結：
 *   位置每頁不一樣，使用者要先找「返回在哪」；而且純文字在一堆資料裡
 *   辨識度很低，常常被當成說明文字。
 *
 * 固定在最上方的導覽列解決三件事：
 *   1. 位置永遠一致，不用找
 *   2. 用底色標出目前在哪一頁
 *   3. 可以直接跳到任一頁，不只是「上一頁」
 *
 * 個股頁多一顆「返回」，因為它是從篩選器或即時報價點進來的，
 * 回到「剛才那一頁」比回到首頁更符合當下的意圖。
 */

const TABS = [
  { href: '/', label: '台股篩選器' },
  { href: '/live', label: '即時報價' },
] as const;

export default function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const isStock = pathname.startsWith('/stock/');

  /**
   * 直接開連結進來（沒有站內的上一頁）時，返回要退回首頁而不是跳出站外。
   *
   * 這個判斷放在點擊當下而不是 effect 裡：referrer 不會變，
   * 沒必要為它存一份 state，在 effect 裡同步 setState 還會觸發連鎖 render。
   */
  const goBack = () => {
    let sameSite = false;
    try {
      sameSite = document.referrer.startsWith(window.location.origin);
    } catch {
      sameSite = false;
    }
    if (sameSite) router.back();
    else router.push('/');
  };

  return (
    <nav className="sticky top-0 z-30 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
      <div className="mx-auto flex max-w-[1800px] items-center gap-2 px-4 py-2">
        {isStock && (
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm transition hover:bg-zinc-50 active:scale-[.98] dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            <span aria-hidden>←</span> 返回
          </button>
        )}

        <div className="flex gap-1">
          {TABS.map((t) => {
            const active = t.href === '/' ? pathname === '/' : pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  active
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </div>

        {isStock && (
          <span className="ml-auto hidden text-xs text-zinc-400 sm:block">個股線圖</span>
        )}
      </div>
    </nav>
  );
}
