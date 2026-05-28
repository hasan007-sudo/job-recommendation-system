import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium tracking-[0.02em] transition-colors",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--ink)] text-[var(--paper-2)] border border-[var(--ink)]",
        outline:
          "bg-transparent text-[var(--ink)] border border-[var(--rule)]",
        accent:
          "bg-[var(--accent)] text-[var(--paper)] border border-[var(--accent)]",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
