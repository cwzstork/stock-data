'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface PickedStock {
  stock_id: string;
  stock_name: string;
  market: string;
  industry_category?: string | null;
}

const MARKET_LABEL: Record<string, string> = { twse: '上市', tpex: '上櫃', emerging: '興櫃' };

interface Props {
  /** 送出時的 form 欄位名，值是逗號分隔的股號 */
  name: string;
  initial: PickedStock[];
  max: number;
}

/**
 * 股票多選器：打字跳候選、點選加入、chip 可移除。
 *
 * 為什麼不用原生 <datalist>：
 *   它只能選一個值、沒辦法顯示股號與股名兩欄、也無法「全部加入」。
 *   這裡要的是多選，只能自己做。
 *
 * 送出的還是一般的 GET form，所以條件一樣留在網址上，可以加書籤與分享。
 */
export default function StockPicker({ name, initial, max }: Props) {
  const [picked, setPicked] = useState<PickedStock[]>(initial);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PickedStock[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pickedIds = useMemo(() => new Set(picked.map((p) => p.stock_id)), [picked]);
  const full = picked.length >= max;

  const trimmed = query.trim();
  // 空字串時不要在 effect 裡把 hits/open 清成空——那是同步 setState，
  // React 會警告會觸發連鎖 render。改成直接由 query 衍生出要不要顯示。
  const visibleHits = trimmed === '' ? [] : hits;
  const showList = open && trimmed !== '';

  // 每打一個字就打一次 API 太吵，等停下來再查
  useEffect(() => {
    const q = query.trim();
    if (q === '') return;
    // 上一個請求還沒回來就換了字，結果到了也沒用，直接中止
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const data = (await res.json()) as { total: number; hits: PickedStock[] };
        setHits(data.hits);
        setTotal(data.total);
        setActive(0);
        setOpen(true);
      } catch {
        // 被 abort 或網路錯誤，維持上一次的結果就好，不要跳錯誤嚇人
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  // 點到元件外面就收起來
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const add = (s: PickedStock) => {
    setPicked((cur) => (cur.some((p) => p.stock_id === s.stock_id) || cur.length >= max ? cur : [...cur, s]));
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  };

  const addAll = () => {
    setPicked((cur) => {
      const ids = new Set(cur.map((p) => p.stock_id));
      const next = [...cur];
      for (const h of visibleHits) {
        if (next.length >= max) break;
        if (!ids.has(h.stock_id)) next.push(h);
      }
      return next;
    });
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  };

  const remove = (id: string) => setPicked((cur) => cur.filter((p) => p.stock_id !== id));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && query === '' && picked.length > 0) {
      // 輸入框空的時候按倒退鍵，刪掉最後一個 chip——這是多選輸入的通用慣例
      setPicked((cur) => cur.slice(0, -1));
      return;
    }
    if (!showList || visibleHits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % visibleHits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + visibleHits.length) % visibleHits.length);
    } else if (e.key === 'Enter') {
      // 選單開著時 Enter 是「選這一筆」，不是送出表單
      e.preventDefault();
      add(visibleHits[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <input type="hidden" name={name} value={picked.map((p) => p.stock_id).join(',')} />

      <div className="flex flex-wrap items-center gap-1 rounded border border-zinc-300 bg-white p-1.5 dark:border-zinc-700 dark:bg-zinc-900">
        {picked.map((p) => (
          <span
            key={p.stock_id}
            className="inline-flex items-center gap-1 rounded bg-zinc-100 py-0.5 pl-2 text-sm dark:bg-zinc-800"
          >
            <span className="font-mono text-xs text-zinc-500">{p.stock_id}</span>
            {p.stock_name}
            <button
              type="button"
              onClick={() => remove(p.stock_id)}
              className="px-1.5 text-zinc-400 hover:text-red-600"
              aria-label={`移除 ${p.stock_name}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => visibleHits.length > 0 && setOpen(true)}
          placeholder={full ? `已達上限 ${max} 檔` : picked.length ? '' : '打「台」試試，或直接輸入股號'}
          disabled={full}
          className="min-w-[12rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none disabled:cursor-not-allowed"
          autoComplete="off"
        />
      </div>

      {showList && (
        <div className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {visibleHits.length === 0 && !loading && (
            <p className="px-3 py-2 text-sm text-zinc-500">沒有符合的股票</p>
          )}
          {total > 1 && visibleHits.length > 0 && (
            <button
              type="button"
              onClick={addAll}
              className="w-full border-b border-zinc-100 px-3 py-2 text-left text-sm text-zinc-600 hover:bg-amber-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              全部加入（顯示中的 {visibleHits.length} 檔{total > visibleHits.length ? `，共找到 ${total}` : ''}）
            </button>
          )}
          {visibleHits.map((h, i) => {
            const already = pickedIds.has(h.stock_id);
            return (
              <button
                key={h.stock_id}
                type="button"
                disabled={already}
                onMouseEnter={() => setActive(i)}
                onClick={() => add(h)}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm disabled:opacity-40 ${
                  i === active ? 'bg-amber-50 dark:bg-zinc-800' : ''
                }`}
              >
                <span className="w-16 shrink-0 font-mono text-xs text-zinc-500">{h.stock_id}</span>
                <span className="flex-1">{h.stock_name}</span>
                <span className="shrink-0 text-xs text-zinc-400">
                  {MARKET_LABEL[h.market] ?? h.market}
                  {h.industry_category ? ` · ${h.industry_category}` : ''}
                </span>
                {already && <span className="shrink-0 text-xs text-zinc-400">已加入</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
