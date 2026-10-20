"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-center justify-center px-4 py-16 text-center">
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-absent-soft text-absent">
        <AlertTriangle className="size-5" />
      </span>
      <h1 className="text-title font-semibold">Something went wrong</h1>
      <p className="mt-2 text-md text-muted-foreground">
        The page could not be loaded. No demo or cached data is shown in its place. Please check your connection and try again.
      </p>
      {error.message && <p className="mt-4 w-full rounded-lg bg-muted p-3 text-left font-mono text-xs break-words">{error.message}</p>}
      <Button size="lg" className="mt-6" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
