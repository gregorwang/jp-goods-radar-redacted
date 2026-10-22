"use client";

import type { ItemScheduleMode } from "@jpgr/core";
import { EditorialSelect } from "@/components/editorial-select";

export function ItemScheduleControls({ mode, maxMinutes, onModeChange, onMaxMinutesChange }: {
  mode: ItemScheduleMode;
  maxMinutes: string;
  onModeChange: (mode: ItemScheduleMode) => void;
  onMaxMinutesChange: (value: string) => void;
}) {
  return <>
    <div className="watch-schedule-grid">
      <EditorialSelect index="03" label="频率管理" caption="Schedule" value={mode}
        options={[
          { value: "adaptive", label: "自动调整", code: "AUTO" },
          { value: "fixed", label: "固定频率", code: "FIXED" },
        ]}
        onValueChange={(value) => onModeChange(value === "fixed" ? "fixed" : "adaptive")} />
      {mode === "adaptive" && <EditorialSelect index="04" label="最长检查间隔" caption="Maximum interval" value={maxMinutes}
        options={[
          { value: "1440", label: "24 小时", code: "1 DAY" },
          { value: "2880", label: "48 小时", code: "2 DAYS" },
          { value: "4320", label: "72 小时", code: "3 DAYS" },
        ]} onValueChange={onMaxMinutesChange} />}
    </div>
    <p className="schedule-separation-note">{mode === "adaptive"
      ? "价格与库存稳定时逐渐延长间隔；小幅价格变化时缩短，确认降价或库存变化后恢复基础频率并密切观察。"
      : "始终使用所选频率，不会自动降频。重点商品可选择每 30 分钟；夜间暂停与来源冷却仍按现有设置执行。"}</p>
  </>;
}
