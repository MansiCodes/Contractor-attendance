import { cn } from "@/lib/utils";

// Low-chroma tints so contractors are easy to tell apart without competing with status colours.
const COLORS = [
  "bg-sky-100 text-sky-900",
  "bg-violet-100 text-violet-900",
  "bg-teal-100 text-teal-900",
  "bg-orange-100 text-orange-900",
  "bg-stone-200 text-stone-800",
];

function initials(name: string) {
  const words = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  return (words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "");
}

const SIZES = {
  xs: "size-7 rounded-md text-2xs",
  sm: "size-9 rounded-lg text-xs",
  md: "size-11 rounded-xl text-sm",
  lg: "size-16 rounded-2xl text-xl",
} as const;

export function ContractorAvatar({ name, photoUrl, size = "md", className }: { name: string; photoUrl: string | null; size?: keyof typeof SIZES; className?: string }) {
  if (photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- signed/data URLs; no optimisation needed
    return <img src={photoUrl} alt={`${name} photo`} className={cn(SIZES[size], "shrink-0 object-cover shadow-surface", className)} />;
  }
  const color = COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
  return (
    <span aria-hidden className={cn(SIZES[size], color, "grid shrink-0 place-items-center font-semibold uppercase", className)}>
      {initials(name)}
    </span>
  );
}
