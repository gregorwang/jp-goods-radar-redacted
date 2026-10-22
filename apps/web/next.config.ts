import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import path from "node:path";

initOpenNextCloudflareForDev({
  // AI bindings are remote-only during local development. CI builds must stay
  // credential-free; the deployed Worker receives the real binding at runtime.
  remoteBindings: process.env.CI !== "true",
});

// 字体、噪点与背景图都在 /art 本地目录；外链只有 Rakuten 授权标识与各来源商品图，
// 因此 img-src 需要放开 https:，其余指令保持自身来源。开发模式下 React Refresh 依赖
// eval，只在非生产构建追加 'unsafe-eval'。
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
  // Next's default server bundle resolves pg-cloudflare to its intentional
  // non-Worker empty export. Keep both packages external so OpenNext can copy
  // them and apply the package's `workerd` condition during its final bundle.
  serverExternalPackages: ["pg", "pg-cloudflare"],
  typedRoutes: true,
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  webpack(config, { isServer }) {
    // 共享包使用 Node ESM 规范的 `.js` 相对导入；源码开发时让 Webpack
    // 按 TypeScript 的扩展名替换规则回落到同名 `.ts` 文件。
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    if (isServer && Array.isArray(config.externals)) {
      config.externals.push({
        pg: "commonjs pg",
        "pg-cloudflare": "commonjs pg-cloudflare",
      });
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      // 管理端响应必须显式声明不可缓存。缺少 Cache-Control 时 RFC 9111 的启发式新鲜度
      // 会让 200 响应被缓存约两小时，一旦启用 Workers Cache 就会把已登录数据发给匿名请求。
      ...[
        "/",
        "/api/:path*",
        "/dashboard/:path*",
        "/search/:path*",
        "/watches/:path*",
        "/listings/:path*",
        "/events/:path*",
        "/push/:path*",
        "/sources",
        "/intelligence/:path*",
        "/login",
      ].map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Vary", value: "Cookie" },
        ],
      })),
      // 公开只读来源展示页与其数据端点保持可缓存；放在数组末尾以覆盖上面的 no-store，
      // 取值与 Route Handler 自身设置的一致，因此两层谁生效结果都相同。
      {
        source: "/api/public/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=300, s-maxage=3600" }],
      },
      {
        source: "/sources/rakuten",
        headers: [{ key: "Cache-Control", value: "public, max-age=300, s-maxage=3600" }],
      },
      {
        source: "/reports/rezero",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, s-maxage=86400" }],
      },
      {
        source: "/reports/rezero/assets/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
