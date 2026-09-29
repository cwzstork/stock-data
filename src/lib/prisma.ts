import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Prisma 7 起執行期一定要走 driver adapter（schema.prisma 不能再寫 url）。
 * 這裡用 pooled 連線：Neon 的 -pooler endpoint，適合 serverless / 短連線。
 * migrate 走的是 prisma.config.ts 裡的 DIRECT_URL，兩者不要混用。
 *
 * 為什麼要延遲建立：
 *   next build 的 collecting page data 階段會載入這個模組。
 *   如果在模組頂層就讀 DATABASE_URL 並 throw，等於把「建置」綁死在「有資料庫密碼」上。
 *   部署平台上先 deploy、之後才補環境變數是很常見的順序，那樣第一次 build 就會炸。
 *   建置不需要連資料庫，所以連線字串等到真的要下查詢時才檢查。
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

let client: PrismaClient | undefined;

function getClient(): PrismaClient {
  // dev 模式下 Next.js 會 hot reload，不共用會把連線數用光
  client ??= globalForPrisma.prisma;
  if (client) return client;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL 未設定（本機看 .env，雲端看平台的環境變數）');
  }

  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = client;
  return client;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const c = getClient();
    const value = Reflect.get(c, prop, c);
    return typeof value === 'function' ? value.bind(c) : value;
  },
});
