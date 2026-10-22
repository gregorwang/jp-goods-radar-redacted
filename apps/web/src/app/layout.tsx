import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "格银西里尔", template: "%s｜格银西里尔" },
  description: "跨平台日淘搜索、关键词订阅与降价监控。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" data-scroll-behavior="smooth"><body>{children}</body></html>;
}
