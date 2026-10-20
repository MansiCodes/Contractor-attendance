import Link from "next/link";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/*
 * Shared layout primitives. Every screen is composed from these so spacing,
 * type and surfaces stay consistent: one canvas, white grouped surfaces with
 * hairline dividers, and colour only for status.
 */

export function PageHeader({
  title,
  description,
  eyebrow,
  back,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  back?: { href: string; label: string };
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("space-y-3", className)}>
      {back && (
        <Link
          href={back.href}
          className="-ml-1.5 inline-flex h-8 items-center gap-0.5 rounded-md pr-2 pl-0.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 space-y-1">
          {eyebrow && <div className="text-xs font-medium text-muted-foreground">{eyebrow}</div>}
          <h1 className="text-title font-semibold text-balance">{title}</h1>
          {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={cn("space-y-3", className)} aria-labelledby={id}>
      {(title || actions) && (
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            {title && (
              <h2 id={id} className="text-base font-semibold tracking-tight">
                {title}
              </h2>
            )}
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** White grouped surface. Children are separated by hairlines. */
export function Group({ children, className, as: Tag = "div", ...rest }: { children: React.ReactNode; className?: string; as?: "div" | "ul" | "ol" | "section" } & Record<string, unknown>) {
  return (
    <Tag className={cn("divide-y divide-border overflow-hidden rounded-xl bg-card shadow-surface", className)} {...rest}>
      {children}
    </Tag>
  );
}

/** A tappable row inside a Group, with an optional leading visual and trailing chevron. */
export function LinkRow({
  href,
  leading,
  title,
  subtitle,
  trailing,
  className,
  ...rest
}: {
  href: string;
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
} & Record<string, unknown>) {
  return (
    <Link
      href={href}
      className={cn("flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60 active:bg-muted", className)}
      {...rest}
    >
      {leading}
      <div className="min-w-0 flex-1">
        <div className="truncate text-md font-medium">{title}</div>
        {subtitle && <div className="mt-0.5 truncate text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      {trailing}
      <ChevronRight className="size-4 shrink-0 text-subtle-foreground" />
    </Link>
  );
}

export type Tone = "present" | "absent" | "pending" | "neutral" | "primary";

const TONE: Record<Tone, { pill: string; dot: string; text: string }> = {
  present: { pill: "bg-present-soft text-present", dot: "bg-present", text: "text-present" },
  absent: { pill: "bg-absent-soft text-absent", dot: "bg-absent", text: "text-absent" },
  pending: { pill: "bg-pending-soft text-pending", dot: "bg-pending-dot", text: "text-pending" },
  neutral: { pill: "bg-muted text-muted-foreground", dot: "bg-subtle-foreground", text: "text-muted-foreground" },
  primary: { pill: "bg-primary-soft text-primary", dot: "bg-primary", text: "text-primary" },
};

export function toneClasses(tone: Tone) {
  return TONE[tone];
}

export function StatusPill({ tone, children, className, ...rest }: { tone: Tone; children: React.ReactNode; className?: string } & Record<string, unknown>) {
  return (
    <span
      className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap", TONE[tone].pill, className)}
      {...rest}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", TONE[tone].dot)} />
      {children}
    </span>
  );
}

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", TONE[tone].dot, className)} />;
}

/** Segmented navigation between sibling views (implemented as links so each tab has its own URL). */
export function SegmentedLinks({ items, className, label }: { items: { href: string; label: string; active: boolean; count?: number }[]; className?: string; label?: string }) {
  return (
    <nav aria-label={label} className={cn("no-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0", className)}>
      <div className="inline-flex min-w-full gap-1 rounded-xl bg-muted p-1 sm:min-w-0" role="tablist">
        {items.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            role="tab"
            aria-selected={t.active}
            className={cn(
              "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm font-medium whitespace-nowrap transition-colors sm:flex-none",
              t.active ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="tabular text-xs text-subtle-foreground">{t.count}</span>}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center rounded-xl bg-card px-6 py-10 text-center shadow-surface", className)}>
      {Icon && (
        <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </span>
      )}
      <p className="text-md font-semibold">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("relative overflow-hidden rounded-md bg-muted", className)}>
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.4s_infinite] bg-gradient-to-r from-transparent via-white/60 to-transparent" />
    </div>
  );
}

/** Compact metric. Numbers lead; labels are quiet. */
export function Stat({
  label,
  value,
  tone,
  href,
  hint,
  ...rest
}: {
  label: string;
  value: React.ReactNode;
  tone?: Tone;
  href?: string;
  hint?: React.ReactNode;
} & Record<string, unknown>) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {tone && <Dot tone={tone} className="size-1.5" />}
        {label}
      </div>
      <div className="tabular mt-1 text-2xl leading-8 font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </>
  );
  const cls = "block min-w-0 px-4 py-3.5";
  return href ? (
    <Link href={href} className={cn(cls, "transition-colors hover:bg-muted/60")} {...rest}>
      {body}
    </Link>
  ) : (
    <div className={cls} {...rest}>
      {body}
    </div>
  );
}

/** Horizontal bar split into present / absent / pending. */
export function AttendanceBar({ present, absent, total, className }: { present: number; absent: number; total: number; className?: string }) {
  const pct = (n: number) => (total > 0 ? `${(n / total) * 100}%` : "0%");
  return (
    <div className={cn("flex h-1.5 w-full overflow-hidden rounded-full bg-border/70", className)} aria-hidden>
      <div className="h-full bg-present transition-[width] duration-300 ease-(--ease-snappy)" style={{ width: pct(present) }} />
      <div className="h-full bg-absent transition-[width] duration-300 ease-(--ease-snappy)" style={{ width: pct(absent) }} />
    </div>
  );
}
