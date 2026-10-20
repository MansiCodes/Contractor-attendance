import Link from "next/link";
import { Compass } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-center justify-center px-4 py-16 text-center">
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
        <Compass className="size-5" />
      </span>
      <h1 className="text-title font-semibold">Page not found</h1>
      <p className="mt-2 text-md text-muted-foreground">This page does not exist or you do not have access to it.</p>
      <Link href="/" className={buttonVariants({ size: "lg", className: "mt-6" })}>
        Go to home
      </Link>
    </div>
  );
}
