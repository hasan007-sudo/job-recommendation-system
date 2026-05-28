import * as React from "react";
import { cn } from "../../lib/utils";

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(function Label(
  { className, ...props },
  ref
) {
  return (
    <label
      ref={ref}
      className={cn(
        "block text-[10px] font-medium uppercase tracking-[0.22em] text-[var(--ink-mute)] [font-family:var(--font-mono)]",
        className
      )}
      {...props}
    />
  );
});
