import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Prisma 7 起執行期一定要走 driver adapter（schema.prisma 不能再寫 url）。
// 這裡用 pooled 連線：Neon 的 -pooler endpoint，適合 serverless / 短連線。
// migrate 走的是 prisma.config.ts 裡的 DIRECT_URL，兩者不要混用。
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL 未設定（本機看 .env，雲端看平台的環境變數）');
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// dev 模式下 Next.js 會 hot reload，不快取會把連線數用光
export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
