import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-tabs-list", className)} {...props} />;
}

type TabsTriggerProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
};

export function TabsTrigger({ active = false, className, ...props }: TabsTriggerProps) {
  return (
    <button
      className={cn("ui-tabs-trigger", active && "is-active", className)}
      type="button"
      {...props}
    />
  );
}
