"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { useId } from "react";

export interface EditorialSelectOption {
  value: string;
  label: string;
  code: string;
}

interface EditorialSelectProps {
  index: string;
  label: string;
  caption: string;
  compact?: boolean;
  showCode?: boolean;
  name?: string;
  disabled?: boolean;
  value: string;
  options: readonly EditorialSelectOption[];
  onValueChange: (value: string) => void;
}

export function EditorialSelect({
  index,
  label,
  caption,
  compact = false,
  showCode = true,
  name,
  disabled = false,
  value,
  options,
  onValueChange,
}: EditorialSelectProps) {
  const labelId = useId();
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  if (!selectedOption) return null;

  return (
    <div className="editorial-select" data-compact={compact || undefined} data-disabled={disabled || undefined}>
      {!compact && <div className="editorial-select-label" id={labelId}>
        <span>{index}</span>
        <span>{label}</span>
        <small>{caption}</small>
      </div>}
      <SelectPrimitive.Root name={name} value={selectedOption.value} onValueChange={onValueChange} disabled={disabled}>
        <SelectPrimitive.Trigger
          className="editorial-select-trigger"
          aria-label={compact ? label : undefined}
          aria-labelledby={compact ? undefined : labelId}
        >
          <span className="editorial-select-value">
            <SelectPrimitive.Value aria-label={selectedOption.label}>
              {selectedOption.label}
            </SelectPrimitive.Value>
            {!compact && showCode && <small>{selectedOption.code}</small>}
          </span>
          <SelectPrimitive.Icon className="editorial-select-icon">
            <ChevronDown aria-hidden="true" size={17} strokeWidth={1.35} />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            className="editorial-select-popover"
            position="popper"
            sideOffset={8}
            align="start"
            collisionPadding={18}
            data-compact={compact || undefined}
          >
            <SelectPrimitive.Viewport className="editorial-select-viewport">
              <SelectPrimitive.Group>
                {!compact && <SelectPrimitive.Label className="editorial-select-menu-label">
                  <span>{index}</span>
                  <span>{label}</span>
                  <small>{caption}</small>
                </SelectPrimitive.Label>}
                {options.map((option, optionIndex) => (
                  <SelectPrimitive.Item
                    className="editorial-select-option"
                    key={option.value}
                    value={option.value}
                  >
                    {!compact && <span className="editorial-select-option-index">
                      {String(optionIndex + 1).padStart(2, "0")}
                    </span>}
                    <span className="editorial-select-option-copy">
                      <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                      {!compact && <small>{option.code}</small>}
                    </span>
                    <SelectPrimitive.ItemIndicator className="editorial-select-indicator">
                      <Check aria-hidden="true" size={15} strokeWidth={1.5} />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.Group>
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  );
}
