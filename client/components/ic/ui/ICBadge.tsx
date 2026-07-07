import type { ReactNode } from "react";

type BadgeVariant = "critical" | "warning" | "info" | "success" | "default";

interface ICBadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  critical: "bg-ic-coral/15 text-ic-coral border-ic-coral/30",
  warning: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  info: "bg-ic-turquoise/15 text-ic-turquoise border-ic-turquoise/30",
  success: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  default: "bg-ic-surface-light text-ic-muted border-ic-border",
};

const dotColors: Record<BadgeVariant, string> = {
  critical: "bg-ic-coral",
  warning: "bg-amber-400",
  info: "bg-ic-turquoise",
  success: "bg-emerald-400",
  default: "bg-ic-muted",
};

export default function ICBadge({
  variant = "default",
  children,
  className = "",
}: ICBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold border
        ${variantStyles[variant]} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotColors[variant]}`} />
      {children}
    </span>
  );
}
