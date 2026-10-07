import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppNav from "@/components/AppNav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "台股篩選器",
  description: "上市 / 上櫃 / 興櫃行情與評價指標篩選",
};

/**
 * 不鎖縮放。這是一個有 73 欄寬表格的頁面，
 * 手機上使用者一定會想放大看某幾欄的數字——
 * 設 maximum-scale=1 會把這個能力拿掉，是很常見的無障礙錯誤。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-Hant-TW"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AppNav />
        {children}
      </body>
    </html>
  );
}
