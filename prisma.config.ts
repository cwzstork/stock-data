import { defineConfig } from 'prisma/config';

// Prisma 7 不再自動載入 .env，改用 Node 20.6+ 內建的 loadEnvFile（不必額外裝 dotenv）
try {
  process.loadEnvFile('.env');
} catch {
  // CI 等情境由環境變數直接提供，沒有 .env 是正常的
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // migrate / introspect 必須走 direct 連線（不含 -pooler）。
    // 走 pooler 會因為拿不到 advisory lock 而失敗。
    url: process.env.DIRECT_URL,
  },
});
