'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteMacroReports } from '@/lib/macro-actions';

/**
 * 宏觀事件預覽的匯出 ＋ 刪除。
 *
 * 流程刻意是「先匯出、再問要不要刪」，而且刪的範圍取自匯出回應的標頭，
 * 不是取使用者填的日期——這樣刪掉的一定是剛剛存進檔案裡的那幾份。
 */

interface Exported {
  count: number;
  from: string;
  to: string;
  generatedMax: string;
  fileName: string;
}

export default function MacroExportPanel({
  count,
  from,
  to,
  size,
  canDelete,
}: {
  count: number;
  from: string | null;
  to: string | null;
  size: string;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [range, setRange] = useState({ from: from ?? '', to: to ?? '' });
  // 刪除後頁面重新整理、保留範圍變了，日期欄要跟著換成新的範圍。
  // 在 render 中比對上一次的 props 再更新（React 文件建議的寫法），不用 effect，
  // 這樣剛刪完的成功訊息也不會因為重新掛載而消失
  const [bounds, setBounds] = useState({ from, to });
  if (bounds.from !== from || bounds.to !== to) {
    setBounds({ from, to });
    setRange({ from: from ?? '', to: to ?? '' });
  }
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<Exported | null>(null);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function doExport() {
    setBusy(true);
    setMessage(null);
    setExported(null);
    try {
      const qs = new URLSearchParams({ from: range.from, to: range.to });
      const res = await fetch(`/api/macro/export?${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());

      const fileName =
        /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'macro-report.html';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);

      setExported({
        count: Number(res.headers.get('x-macro-count') ?? 0),
        from: res.headers.get('x-macro-from') ?? '',
        to: res.headers.get('x-macro-to') ?? '',
        generatedMax: res.headers.get('x-macro-generated-max') ?? '',
        fileName,
      });
    } catch (e) {
      setMessage({ ok: false, text: `匯出失敗：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!exported) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await deleteMacroReports({
        from: exported.from,
        to: exported.to,
        generatedMax: exported.generatedMax,
        password,
      });
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) {
        setExported(null);
        setPassword('');
        router.refresh();
      }
    } catch (e) {
      setMessage({ ok: false, text: `刪除失敗：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const input =
    'rounded border border-zinc-300 bg-white px-2 py-2 text-sm sm:py-1.5 dark:border-zinc-700 dark:bg-zinc-900';

  return (
    <div className="mb-6 rounded-lg border border-zinc-200 p-3 text-sm sm:p-4 dark:border-zinc-800">
      <p className="mb-3 text-zinc-600 dark:text-zinc-300">
        目前保留 <strong>{count}</strong> 份
        {from && to && (
          <>
            （{from}～{to}）
          </>
        )}
        ，資料庫佔用約 <strong>{size}</strong>。報告每天都會留下，匯出存檔後可以刪掉騰出免費空間。
      </p>

      {count > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            從
            <input
              type="date"
              value={range.from}
              min={from ?? undefined}
              max={to ?? undefined}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className={input}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            到
            <input
              type="date"
              value={range.to}
              min={from ?? undefined}
              max={to ?? undefined}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className={input}
            />
          </label>
          <button
            type="button"
            onClick={doExport}
            disabled={busy || !range.from || !range.to || range.from > range.to}
            className="rounded bg-zinc-900 px-4 py-2.5 text-sm text-white disabled:opacity-50 sm:py-2 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy && !exported ? '匯出中…' : '匯出報告（HTML）'}
          </button>
        </div>
      )}

      {exported && (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
          <p>
            已下載 <code className="font-mono text-xs">{exported.fileName}</code>，共 {exported.count} 份（
            {exported.from}～{exported.to}）。
          </p>
          {canDelete ? (
            <>
              <p className="mt-1">
                要把這 {exported.count} 份從資料庫刪除嗎？<strong>刪除後無法復原</strong>，
                請先確認檔案已經存好、打得開。不刪也沒關係，資料會繼續保留。
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="管理密碼"
                  autoComplete="current-password"
                  className={`${input} w-40`}
                />
                <button
                  type="button"
                  onClick={doDelete}
                  disabled={busy || !password}
                  className="rounded bg-red-600 px-4 py-2.5 text-sm text-white disabled:opacity-50 sm:py-2"
                >
                  {busy ? '刪除中…' : `刪除這 ${exported.count} 份`}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExported(null);
                    setPassword('');
                  }}
                  disabled={busy}
                  className="rounded border border-zinc-300 px-4 py-2.5 text-sm sm:py-2 dark:border-zinc-700"
                >
                  保留，不刪
                </button>
              </div>
            </>
          ) : (
            <p className="mt-1 text-zinc-600 dark:text-zinc-300">
              刪除功能沒有啟用：要在 Vercel 的 Environment Variables 設定 <code>MACRO_ADMIN_PASSWORD</code>
              並重新部署，之後匯出完這裡就會出現刪除選項。
            </p>
          )}
        </div>
      )}

      {message && (
        <p
          className={`mt-3 ${message.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
          role="status"
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
