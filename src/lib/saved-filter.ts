'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from './prisma';

/**
 * 篩選條件儲存器。
 *
 * 存的是「條件」不是「結果」。結果隔天股價一變就不準，條件則永遠可以重跑，
 * 所以這裡存的內容就是網址的 query string——跟你把網址分享給別人是同一份東西。
 */

export interface SavedFilterRow {
  id: number;
  name: string;
  query: string;
  created_at: string;
}

export async function listSavedFilters(): Promise<SavedFilterRow[]> {
  return prisma.$queryRawUnsafe<SavedFilterRow[]>(
    `SELECT id, name, query, to_char(created_at, 'YYYY-MM-DD') AS created_at
       FROM saved_filter ORDER BY created_at DESC, id DESC LIMIT 100`,
  );
}

/** 只留下篩選相關的參數：分頁與基準日不該被存進去 */
const VOLATILE = new Set(['page', 'size', 'date']);

// 不 export：'use server' 模組裡匯出的東西都會被當成 server action，
// 而 server action 必須是 async。這支是純字串處理，留在模組內即可。
function cleanQuery(raw: string): string {
  const src = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  const out = new URLSearchParams();
  for (const [k, v] of [...src.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (VOLATILE.has(k) || v.trim() === '') continue;
    out.append(k, v);
  }
  return out.toString();
}

export async function saveFilter(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim().slice(0, 60);
  const query = cleanQuery(String(formData.get('query') ?? ''));
  if (!name) return;

  // name 有唯一約束，同名就是覆蓋，不會按幾次就多幾筆一樣的
  await prisma.$executeRawUnsafe(
    `INSERT INTO saved_filter (name, query) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET query = EXCLUDED.query, created_at = now()`,
    name,
    query,
  );
  revalidatePath('/');
}

export async function deleteFilter(formData: FormData) {
  const id = Number(formData.get('id'));
  if (!Number.isInteger(id)) return;
  await prisma.$executeRawUnsafe(`DELETE FROM saved_filter WHERE id = $1`, id);
  revalidatePath('/');
}
