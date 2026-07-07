interface SkeletonProps {
  className?: string;
}

export default function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-ic-surface-light/60 ${className}`}
    />
  );
}

/** Skeleton placeholder for the Deal List page */
export function DealListSkeleton() {
  return (
    <div className="flex flex-col h-full min-h-screen bg-ic-dark">
      {/* Header skeleton */}
      <header className="flex items-center justify-between px-8 py-5 border-b border-ic-border">
        <div className="flex items-center gap-3">
          <Skeleton className="w-9 h-9" />
          <Skeleton className="w-48 h-6" />
        </div>
        <Skeleton className="w-28 h-9" />
      </header>

      {/* Content skeleton */}
      <div className="flex-1 px-8 py-6">
        <Skeleton className="w-80 h-10 mb-6" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="bg-ic-surface border border-ic-border rounded-xl p-5 space-y-4"
            >
              <Skeleton className="w-3/4 h-5" />
              <Skeleton className="w-1/2 h-4" />
              <Skeleton className="w-full h-3" />
              <div className="flex justify-between">
                <Skeleton className="w-20 h-4" />
                <Skeleton className="w-20 h-4" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Skeleton placeholder for the Deal Dashboard sidebar */
function SidebarSkeleton() {
  return (
    <aside className="w-80 min-w-80 bg-ic-surface border-r border-ic-border flex flex-col h-full">
      <div className="px-5 py-3 border-b border-ic-border">
        <Skeleton className="w-20 h-4" />
      </div>
      <div className="p-5 border-b border-ic-border space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex justify-between">
            <Skeleton className="w-20 h-4" />
            <Skeleton className="w-24 h-4" />
          </div>
        ))}
      </div>
      <div className="p-5 border-b border-ic-border space-y-2">
        <Skeleton className="w-24 h-4 mb-3" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="w-full h-8" />
        ))}
      </div>
      <div className="p-5 space-y-2">
        <Skeleton className="w-32 h-4 mb-3" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="w-full h-5" />
        ))}
      </div>
    </aside>
  );
}

/** Skeleton placeholder for the Deal Dashboard main content */
export function DashboardSkeleton() {
  return (
    <div className="flex h-full min-h-screen bg-ic-dark overflow-hidden">
      <SidebarSkeleton />
      <div className="flex-1 flex flex-col">
        {/* Header skeleton */}
        <div className="flex items-center justify-between px-8 py-4 border-b border-ic-border">
          <div className="flex items-center gap-3">
            <Skeleton className="w-6 h-6" />
            <Skeleton className="w-40 h-6" />
            <Skeleton className="w-16 h-5" />
          </div>
          <Skeleton className="w-36 h-9" />
        </div>
        {/* Stats row skeleton */}
        <div className="px-8 py-6 space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="bg-ic-surface border border-ic-border rounded-xl p-4 space-y-2"
              >
                <Skeleton className="w-16 h-4" />
                <Skeleton className="w-10 h-7" />
              </div>
            ))}
          </div>
          {/* Module grid skeleton */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="bg-ic-surface border border-ic-border rounded-xl p-5 space-y-3"
              >
                <Skeleton className="w-3/4 h-5" />
                <Skeleton className="w-full h-4" />
                <Skeleton className="w-1/2 h-4" />
                <div className="flex gap-2">
                  <Skeleton className="w-16 h-6" />
                  <Skeleton className="w-16 h-6" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
