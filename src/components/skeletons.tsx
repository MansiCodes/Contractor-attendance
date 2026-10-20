import { Skeleton } from "@/components/kit";

/** Placeholder with the same shape as the attendance register, so nothing jumps when it loads. */
export function RegisterSkeleton() {
  return (
    <div className="space-y-4" aria-busy aria-label="Loading register">
      <div className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-3/4" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-15 w-full rounded-xl" />
      <Skeleton className="h-12 w-full rounded-xl" />
      <div className="-mx-4 divide-y bg-card shadow-surface sm:mx-0 sm:rounded-xl">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-2 px-4 py-2.5">
            <div className="flex justify-between">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
            <div className="flex justify-between">
              <div className="flex gap-2">
                <Skeleton className="h-11 w-25 rounded-lg" />
                <Skeleton className="h-11 w-24 rounded-lg" />
              </div>
              <Skeleton className="h-11 w-22 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Generic page placeholder: heading, a summary strip and a list. */
export function PageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-6" aria-busy aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Skeleton className="h-20 w-full rounded-xl" />
      <div className="divide-y rounded-xl bg-card shadow-surface">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
