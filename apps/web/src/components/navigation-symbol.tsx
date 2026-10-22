export type NavigationSymbolName = "overview" | "search" | "watches" | "archive" | "changes" | "review" | "labels" | "signals" | "sources" | "push";

interface NavigationSymbolProps {
  name: NavigationSymbolName;
  size?: number;
}

function symbolPaths(name: NavigationSymbolName) {
  switch (name) {
    case "overview":
      return (
        <>
          <circle cx="24" cy="24" r="18" />
          <path d="M24 6v8m0-8-3-3m3 3 3-3M24 34v8m0 0-3 3m3-3 3 3M6 24h9m-9 0 3-3m-3 3 3 3m24-3h9m0 0-3-3m3 3-3 3" />
          <path d="m24 14 10 10-10 10-10-10 10-10Z" />
          <path d="M24 18v12m0-10 4 4-4 4" />
        </>
      );
    case "search":
      return (
        <>
          <path d="M8 16V8h8M32 8h8v8M8 32v8h8" />
          <path d="m24 13 12 12-12 12-12-12 12-12Z" />
          <path d="M31.5 32.5 42 43M35 36l3-3M23 18v14m0-11 7 7v-7" />
          <path d="m17 25 2-2 2 2-2 2-2-2Z" fill="currentColor" stroke="none" />
        </>
      );
    case "watches":
      return (
        <>
          <path d="M13 5h22v35L24 32 13 40V5Z" />
          <path d="M17 9h14v22l-7-5-7 5V9Z" strokeWidth="1.9" />
          <path d="M24 12v15m0-9 6-5m-6 11 6-5" />
          <path d="m24 34 3 3-3 3-3-3 3-3Z" />
        </>
      );
    case "archive":
      return (
        <>
          <path d="m7 15 9-8h24l5 6v25l-5 5H9l-4-4V17l2-2Z" />
          <path d="M7 15h31l7-2M5 24h34l6-5M38 15v28" />
          <path d="m24 27 6 6-6 6-6-6 6-6ZM24 29v8m0-6 3 3" />
        </>
      );
    case "signals":
      return (
        <>
          <path d="m24 11 6 6-6 6-6-6 6-6ZM24 23v18m-8 5 8-8 8 8M24 3v8m0-8-3 3m3-3 3 3" />
          <path d="M15 12c-5 6-5 13 0 19m18-19c5 6 5 13 0 19M10 8C2 17 3 28 10 36m28-28c8 9 7 20 0 28" strokeWidth="1.9" />
          <path d="m21 27 6-5m-6 11 6-5" />
        </>
      );
    case "changes":
      return (
        <>
          <path d="M8 24h7l4-10 7 20 5-12h9" />
          <path d="M8 8v32m32-32v32" />
          <path d="m20 12 4-4 4 4m-4 24-4 4 4 4" />
        </>
      );
    case "review":
      return (
        <>
          <path d="M9 5h21l9 9v29H9V5Z" />
          <path d="M30 5v9h9" />
          <path d="m24 21 7 7-7 7-7-7 7-7Z" />
          <path d="m21 28 2 2 4-4" strokeWidth="1.9" />
        </>
      );
    case "labels":
      // 一张商品卡，左半边打叉、右半边打勾：日报标注只做这两种判断。
      return (
        <>
          <path d="M8 8h32v32H8V8Z" />
          <path d="M24 8v32" />
          <path d="m12 20 8 8m0-8-8 8" />
          <path d="m28 24 3 3 6-6" />
        </>
      );
    case "sources":
      return (
        <>
          <path d="m24 4 7 7-7 7-7-7 7-7ZM24 18v22M24 24 12 35m12-11 12 11" />
          <path d="m11 31 6 6-6 6-6-6 6-6Zm26 0 6 6-6 6-6-6 6-6Zm-13 9 4 4-4 4-4-4 4-4Z" />
        </>
      );
    case "push":
      return (
        <>
          <path d="M6 22 42 7 33 41 22 29 6 22Z" />
          <path d="m42 7-20 22v12l6-7" />
          <path d="m24 4 3 3-3 3-3-3 3-3Z" />
        </>
      );
  }
}

export function NavigationSymbol({ name, size = 20 }: NavigationSymbolProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.65"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      {symbolPaths(name)}
    </svg>
  );
}
