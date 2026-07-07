import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router";
import { Plus, Search, BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { useApiData } from "@/hooks/useApiData.js";
import { useApi } from "@/hooks/useApi.js";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";
import type { Deal } from "@/types/deal";
import ICButton from "@/components/ic/ui/ICButton";
import ICModal from "@/components/ic/ui/ICModal";
import DealForm from "@/components/ic/deal/DealForm";
import DealCard from "@/components/ic/deal/DealCard";

export { DealListPage as Component };

export default function DealListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // --- Live data ---
  const { data, loading, fetching, isError, error, refetch } = useApiData("ListDeals", {
    search: debouncedSearch || null,
  });
  const deals = (data?.deals ?? []) as Deal[];

  const { run: createDealApi } = useApi("CreateDeal");
  const { run: deleteDealApi } = useApi("DeleteDeal");

  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timerRef.current);
  }, [search]);

  const handleCreate = useCallback(
    async (data: { name: string; sector: string; description: string }) => {
      try {
        const result = await createDealApi({
          name: data.name,
          sector: data.sector || "General",
          description: data.description || null,
          entry_ev: null,
          entry_multiple: null,
          equity_check: null,
          ic_date: null,
        });
        setShowCreateModal(false);
        navigate(`/deals/${result?.deal?.id}`);
      } catch (err) {
        const message =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        toast.error("Failed to create deal: " + message);
      }
    },
    [navigate, createDealApi]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteDealApi({ dealId: id });
        await refetch();
        toast.success("Deal deleted");
      } catch (err) {
        const message =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        toast.error("Failed to delete deal: " + message);
      }
    },
    [deleteDealApi, refetch]
  );

  const getModuleProgress = useCallback((_dealId: string) => {
    // Module progress comes from deal-level counts now
    return { completed: 0, total: MODULE_DEFINITIONS.length };
  }, []);

  return (
    <div className="flex flex-col h-full min-h-screen bg-ic-dark overflow-auto">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-6 border-b border-ic-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-ic-turquoise/15 flex items-center justify-center">
            <BarChart3 className="w-5 h-5 text-ic-turquoise" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-ic-text tracking-tight">IC Diligence Assistant</h1>
            <p className="text-xs text-ic-muted font-light mt-0.5">Prov Equity</p>
          </div>
        </div>
        <ICButton onClick={() => setShowCreateModal(true)} glow>
          <Plus className="w-4 h-4" />
          New Deal
        </ICButton>
      </header>

      {/* Content */}
      <div className="flex-1 px-8 py-8">
        {/* Search */}
        <div className="relative max-w-md mb-8">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ic-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search deals by name or sector..."
            className="w-full bg-ic-surface border border-ic-border rounded-lg pl-10 pr-4 py-2.5
                       text-sm text-ic-text placeholder:text-ic-muted
                       focus:outline-none focus:ring-2 focus:ring-ic-turquoise/40 focus:border-ic-turquoise"
          />
        </div>

        {/* Deal grid */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-40 bg-ic-surface rounded-xl border border-ic-border animate-pulse" />
            ))}
          </div>
        ) : isError ? (
          <div className="text-center py-20">
            <p className="text-ic-coral text-sm mb-2">Failed to load deals</p>
            <p className="text-ic-muted text-xs">{(error as Error | undefined)?.message ?? "Unknown error"}</p>
            <button onClick={() => refetch()} className="mt-3 text-ic-turquoise text-sm hover:underline cursor-pointer">
              Retry
            </button>
          </div>
        ) : deals.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-ic-muted text-sm">
              {debouncedSearch
                ? "No deals match your search."
                : "No deals yet. Create your first deal to get started."}
            </p>
          </div>
        ) : (
          <div className={fetching && !loading ? "opacity-70" : ""}>
            {fetching && !loading && (
              <div className="text-xs text-ic-muted mb-2">Updating…</div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {deals.map((deal) => (
                <DealCard
                  key={deal.id}
                  deal={deal}
                  moduleProgress={getModuleProgress(deal.id)}
                  onClick={() => navigate(`/deals/${deal.id}`)}
                  onDelete={() => handleDelete(deal.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Create Modal */}
      <ICModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Create New Deal"
      >
        <DealForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreateModal(false)}
        />
      </ICModal>
    </div>
  );
}
