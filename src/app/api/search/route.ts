import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export interface SearchHit {
  stock_id: string;
  stock_name: string;
  market: string;
  industry_category: string | null;
}

/** 下拉選單一次顯示的上限。再多使用者也不會捲完。 */
const LIMIT = 20;

/**
 * 股票搜尋，給即時報價頁的多選器用。
 *
 * 一個關鍵字可以是股號（2330）、股號開頭（233）、或股名的一部分（台、高股息）。
 * 中文用 ILIKE 做包含比對——台股股名很短，只做前綴比對會漏掉
 * 「元大高股息」這種要用中間字找的情況。
 *
 * 排序分四級：
 *   0 完全等於股號      打「2330」第一筆一定是台積電
 *   1 股號開頭符合      打「233」→ 2330, 2331, 2332…
 *   2 股名開頭符合      打「台」→ 台泥、台積電、台光電
 *   3 股名中間包含      打「台」→ 元大台灣50、富邦摩台…
 *
 * 第 2 級與第 3 級一定要分開。合在一起的話打「台」會先跑出一堆
 * 「主動摩根台灣鑫收」這種 ETF（股號 00401A 排序在前），
 * 使用者想找的台泥、台積電反而被擠到看不見的地方。
 */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length === 0) {
    return Response.json({ total: 0, hits: [] });
  }

  const rows = await prisma.$queryRawUnsafe<(SearchHit & { rank: number; total: number })[]>(
    `SELECT stock_id, stock_name, market, industry_category, rank,
            count(*) OVER ()::int AS total
       FROM (
         SELECT s.stock_id, s.stock_name, s.market, s.industry_category,
                CASE WHEN s.stock_id = $1 THEN 0
                     WHEN s.stock_id LIKE $1 || '%' THEN 1
                     WHEN s.stock_name ILIKE $1 || '%' THEN 2
                     ELSE 3 END AS rank
           FROM stock s
          WHERE s.stock_id = $1
             OR s.stock_id LIKE $1 || '%'
             OR s.stock_name ILIKE '%' || $1 || '%'
       ) t
      -- 股名字數只用在「靠股名找到」的那兩級：打「台」時台泥要排在台灣水泥類前面。
      -- 股號那兩級不能用字數排，否則打「233」會變成
      -- 精英(2字) 友訊(2字) … 台積電(3字) 排最後，而使用者要的就是 2330。
      ORDER BY rank,
               CASE WHEN rank <= 1 THEN 0 ELSE length(stock_name) END,
               stock_id
      LIMIT ${LIMIT}`,
    q,
  );

  return Response.json(
    {
      // count(*) OVER () 是套 LIMIT 之前的總數，用來顯示「全部加入（N 檔）」
      total: rows[0]?.total ?? 0,
      hits: rows.map(({ stock_id, stock_name, market, industry_category }) => ({
        stock_id,
        stock_name,
        market,
        industry_category,
      })),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
