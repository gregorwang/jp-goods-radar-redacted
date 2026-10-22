const TOKYO = "Asia/Tokyo";

/**
 * 全站时间统一按 Asia/Tokyo 呈现——商品、上新与拍卖结束时间都在日本时区，
 * 应用页头也明确标注了 Asia/Tokyo。此前通知中心固定东京、仪表盘用浏览器本地时区、
 * 商品库连 locale 都不传，同一个事件在两个面板会显示成两个时间。
 */
export function tokyoDateTime(value: Date | string | number): string {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: TOKYO,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function tokyoFull(value: Date | string | number): string {
  return new Date(value).toLocaleString("zh-CN", { timeZone: TOKYO, hour12: false });
}

export function tokyoDate(value: Date | string | number): string {
  return new Date(value).toLocaleDateString("zh-CN", {
    timeZone: TOKYO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
