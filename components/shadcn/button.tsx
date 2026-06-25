import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,color,box-shadow,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--paper)] disabled:pointer-events-none disabled:opacity-40 [appearance:none] [-webkit-appearance:none] cursor-pointer border",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--ink)] text-[var(--paper)] border-[var(--ink)] hover:bg-[var(--ink-soft)] active:translate-y-[1px]",
        outline:
          "bg-transparent text-[var(--ink)] border-[var(--rule)] hover:border-[var(--rule-strong)]",
        ghost:
          "bg-transparent text-[var(--ink-3)] border-transparent hover:text-[var(--ink)]",
        link:
          "bg-transparent text-[var(--ink-2)] border-transparent rounded-none hover:text-[var(--ink)]",
        accent:
          "bg-[var(--accent)] text-[var(--paper)] border-[var(--accent)] hover:bg-[var(--accent-soft)] active:translate-y-[1px]",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-14 px-6 text-md",
        icon: "h-6 w-6 p-0",
        auto: "h-auto p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant, size, type, ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  }
);

export { buttonVariants };
