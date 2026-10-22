import type { SourceId } from "@jpgr/core";
import type { WatchSourcePreset } from "@/lib/watch-source-presets";

export interface WatchSourceChoice {
  id: SourceId;
  display_name: string;
  enabled: number;
  adapter_available: boolean;
  health_status: string;
  monitoring_allowed: boolean;
}

export const WATCH_SOURCE_LABELS = {
  amiami: "AmiAmi（あみあみ）",
  rakuten_ichiba: "乐天市场",
  rakuten_books: "Rakuten Books",
  yahoo_shopping: "Yahoo! Shopping（实验）",
  yahoo_auctions_jp: "Yahoo!オークション（实验）",
  yahoo_fleamarket_jp: "Yahoo!フリマ",
  amazon_jp: "Amazon Japan",
  mercari_jp: "Mercari",
  surugaya: "骏河屋",
  charaon: "CharaON",
  cospa: "COSPA",
  animate: "Animate 通贩",
} satisfies Partial<Record<SourceId, string>>;

function isLabelledSource(source: SourceId): source is keyof typeof WATCH_SOURCE_LABELS {
  return source in WATCH_SOURCE_LABELS;
}

export function watchSourceLabel(source: SourceId): string | undefined {
  return isLabelledSource(source) ? WATCH_SOURCE_LABELS[source] : undefined;
}

interface WatchSourcePickerProps {
  choices: readonly WatchSourceChoice[];
  selected: readonly SourceId[];
  onToggle: (source: SourceId) => void;
  onSelectAll: () => void;
  onSelectPreset?: (preset: WatchSourcePreset) => void;
  onClear: () => void;
}

export function WatchSourcePicker({
  choices,
  selected,
  onToggle,
  onSelectAll,
  onSelectPreset,
  onClear,
}: WatchSourcePickerProps) {
  return (
    <fieldset className="watch-source-picker">
      <legend>扫描来源</legend>
      <div className="source-picker-toolbar">
        <span>已选 {selected.length} / {choices.length}</span>
        {onSelectPreset && <button type="button" onClick={() => onSelectPreset("resale")}>二手优先</button>}
        {onSelectPreset && <button type="button" onClick={() => onSelectPreset("retail")}>新品零售</button>}
        <button type="button" onClick={onSelectAll}>全市场</button>
        <button type="button" onClick={onClear}>清空</button>
      </div>
      {choices.map((source) => {
        const available = source.adapter_available;
        const checked = selected.includes(source.id);
        return (
          <label key={source.id} data-selected={checked} data-disabled={!available}>
            <input type="checkbox" checked={checked} disabled={!available} onChange={() => onToggle(source.id)} />
            <span>
              <strong>{watchSourceLabel(source.id) ?? source.display_name}</strong>
              <small>{!available ? "适配器未就绪" : source.monitoring_allowed ? "可自动巡回" : "可先保存；来源开放后再启动"}</small>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
