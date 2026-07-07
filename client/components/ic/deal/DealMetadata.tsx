import type { ReactNode } from "react";
import { Building2, Calendar, DollarSign, TrendingUp, Wallet } from "lucide-react";
import type { Deal } from "@/types/deal";
import { formatCurrency, formatMultiple, formatDate } from "@/lib/formatters";

interface DealMetadataProps {
  deal: Deal;
}

export default function DealMetadata({ deal }: DealMetadataProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-[10px] font-bold text-ic-muted uppercase tracking-[0.1em]">
        Deal Info
      </h3>

      <div className="space-y-2.5">
        {deal.sector && (
          <MetadataRow icon={<Building2 className="w-3.5 h-3.5" />} label="Sector" value={deal.sector} />
        )}
        {deal.entry_ev != null && (
          <MetadataRow icon={<DollarSign className="w-3.5 h-3.5" />} label="Entry EV" value={formatCurrency(deal.entry_ev)} />
        )}
        {deal.entry_multiple != null && (
          <MetadataRow icon={<TrendingUp className="w-3.5 h-3.5" />} label="Entry Multiple" value={formatMultiple(deal.entry_multiple)} />
        )}
        {deal.equity_check != null && (
          <MetadataRow icon={<Wallet className="w-3.5 h-3.5" />} label="Equity Check" value={formatCurrency(deal.equity_check)} />
        )}
        {deal.ic_date && (
          <MetadataRow icon={<Calendar className="w-3.5 h-3.5" />} label="IC Date" value={formatDate(deal.ic_date)} />
        )}
      </div>

      {deal.description && (
        <p className="text-xs text-ic-muted font-light leading-relaxed mt-2">{deal.description}</p>
      )}
    </div>
  );
}

function MetadataRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-2 text-ic-muted font-light">
        {icon}
        <span>{label}</span>
      </div>
      <span className="text-ic-text font-bold text-sm">{value}</span>
    </div>
  );
}
