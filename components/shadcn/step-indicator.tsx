import { cn } from "../../lib/utils";

export function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-3 [font-family:var(--font-mono)] text-[10px] tracking-[0.22em] text-[var(--ink-mute)]">
      <span className="tabular-nums">
        {String(current).padStart(2, "0")}
        <span className="mx-1 text-[var(--rule)]">/</span>
        {String(total).padStart(2, "0")}
      </span>
      <div className="flex items-center gap-1.5">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={cn(
              "h-[2px] transition-all duration-300",
              i + 1 === current ? "w-7 bg-[var(--ink)]" : i + 1 < current ? "w-7 bg-[var(--ink)]/40" : "w-4 bg-[var(--rule)]"
            )}
          />
        ))}
      </div>
    </div>
  );
}
