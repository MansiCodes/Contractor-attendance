import { cn } from "@/lib/utils";

/** NF Attendance mark: a register page with a confirmed tick. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-md bg-foreground text-background", className)}>
      <svg viewBox="0 0 20 20" className="size-[62%]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 5.5h6" opacity="0.55" />
        <path d="M4.5 10h3.5" opacity="0.55" />
        <path d="M4.5 14.5h3" opacity="0.55" />
        <path d="m10.5 12.5 2.4 2.4 4.6-5.4" />
      </svg>
    </span>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("text-md font-semibold tracking-tight whitespace-nowrap", className)}>
      NF <span className="text-muted-foreground">Attendance</span>
    </span>
  );
}
