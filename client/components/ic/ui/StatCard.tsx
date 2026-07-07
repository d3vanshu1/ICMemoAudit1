import type { ReactNode } from "react";

interface StatCardProps {
  icon: ReactNode;
  label: string;
  value: string | number;
  subValue?: string;
  highlight?: boolean;
}

export default function StatCard({
  icon,
  label,
  value,
  subValue,
  highlight = false,
}: StatCardProps) {
  return (
    <div
      className={`relative overflow-hidden flex items-center gap-4 p-5 rounded-xl border transition-all duration-200
        ${
          highlight
            ? "bg-gradient-to-br from-ic-coral/10 via-ic-surface to-ic-surface border-ic-coral/30"
            : "bg-gradient-to-br from-ic-surface-light/40 via-ic-surface to-ic-surface border-ic-border hover:border-ic-soft-gray/40"
        }`}
    >
      {/* Subtle glow orb behind icon */}
      <div
        className={`absolute -left-4 -top-4 w-20 h-20 rounded-full blur-2xl opacity-20
          ${highlight ? "bg-ic-coral" : "bg-ic-turquoise"}`}
      />
      <div
        className={`relative z-10 p-3 rounded-xl ${
          highlight
            ? "bg-ic-coral/15 text-ic-coral"
            : "bg-ic-turquoise/10 text-ic-turquoise"
        }`}
      >
        {icon}
      </div>
      <div className="relative z-10">
        <p className="text-xs font-light text-ic-muted tracking-wide uppercase mb-1">{label}</p>
        <p
          className={`text-2xl font-bold tracking-tight ${
            highlight ? "text-ic-coral" : "text-ic-text"
          }`}
        >
          {value}
        </p>
        {subValue && (
          <p className="text-[10px] text-ic-muted/70 mt-0.5 font-light">{subValue}</p>
        )}
      </div>
    </div>
  );
}
