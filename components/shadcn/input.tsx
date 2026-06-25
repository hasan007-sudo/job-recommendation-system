import * as React from "react";
import { cn } from "../../lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, type, ...props },
  ref
) {
  return (
    <input
      ref={ref}
      type={type ?? "text"}
      className={cn(
        "w-full bg-transparent border-0 border-b border-[var(--rule)] px-0 py-2 text-md text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-mute)] focus:border-[var(--ink)] disabled:opacity-50 [appearance:none] [-webkit-appearance:none]",
        className
      )}
      {...props}
    />
  );
});
