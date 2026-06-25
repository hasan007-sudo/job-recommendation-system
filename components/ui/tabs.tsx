import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../shadcn/button";

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-tabs-list", className)} {...props} />;
}

type TabsTriggerProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
};

export function TabsTrigger({ active = false, className, ...props }: TabsTriggerProps) {
  return (
    <Button
      variant="ghost"
      size="auto"
      className={cn("ui-tabs-trigger", active && "is-active", className)}
      {...props}
    />
  );
}
