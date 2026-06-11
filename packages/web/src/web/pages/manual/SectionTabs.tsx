import { cn } from "@/lib/utils";
import {
  ManualSection,
  SECTION_LABELS,
  SECTION_ORDERS,
} from "./useManualSequence";

interface SectionTabsProps {
  section: ManualSection;
  onChange: (s: ManualSection) => void;
}

const ORDER: ManualSection[] = ["middle", "lower", "upper"];

export default function SectionTabs({ section, onChange }: SectionTabsProps) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {ORDER.map((s) => {
        const active = s === section;
        const order = SECTION_ORDERS[s];
        const first = order[0] + 1;
        const last = order[order.length - 1] + 1;
        return (
          <button
            key={s}
            onClick={() => onChange(s)}
            className={cn(
              "flex flex-col items-center justify-center py-2.5 rounded-xl border transition-all active:scale-[0.98]",
              active
                ? "bg-primary text-white border-primary shadow-sm"
                : "bg-card text-foreground/85 border-border hover:bg-muted"
            )}
          >
            <span className="text-sm font-bold">{SECTION_LABELS[s]}</span>
            <span
              className={cn(
                "text-[10px] mt-0.5",
                active ? "text-white/80" : "text-muted-foreground"
              )}
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              {first}→{last}
            </span>
          </button>
        );
      })}
    </div>
  );
}
