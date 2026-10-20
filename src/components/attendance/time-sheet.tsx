"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatTime12, isValidTime, shiftTime } from "@/lib/domain/time";
import { cn } from "@/lib/utils";

export interface TimeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** who / what the time is for, shown under the title */
  subject?: string;
  description?: string;
  initialTime: string;
  quickPicks: string[];
  nowTime?: string | null;
  confirmLabel: string;
  /** returns an error message, or null when the time is acceptable */
  validate?: (time: string) => string | null;
  /** optional note shown under the time, e.g. "next day" */
  note?: (time: string) => string | null;
  onConfirm: (time: string) => void;
  onClear?: () => void;
  clearLabel?: string;
}

/** Fast, large-target time entry: a bottom sheet on phones, a small dialog on desktop. */
export function TimeSheet(props: TimeSheetProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-sm">
        {/* Remount the body whenever the sheet opens so it starts from the right time. */}
        {props.open && <TimeSheetBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

const STEPS = [-15, -5, 5, 15];

function TimeSheetBody(props: TimeSheetProps) {
  const [time, setTime] = useState(props.initialTime);
  const error = props.validate?.(time) ?? null;
  const note = props.note?.(time) ?? null;
  const picks = props.nowTime ? [props.nowTime, ...props.quickPicks] : props.quickPicks;

  return (
    <>
      <span aria-hidden className="mx-auto -mt-1 mb-1 h-1 w-10 rounded-full bg-border-strong sm:hidden" />
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
        {(props.subject || props.description) && (
          <DialogDescription>
            {props.subject && <span className="font-medium text-foreground">{props.subject}</span>}
            {props.subject && props.description && <span aria-hidden> · </span>}
            {props.description}
          </DialogDescription>
        )}
      </DialogHeader>

      <div className={cn("rounded-2xl py-4 text-center transition-colors", error ? "bg-absent-soft" : "bg-muted")}>
        <div className="tabular text-5xl leading-none font-semibold tracking-tight" data-testid="time-sheet-value">
          {formatTime12(time)}
        </div>
        <div className="mt-2 h-4 text-xs font-medium text-pending">{note}</div>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {STEPS.map((d) => (
          <Button
            key={d}
            type="button"
            variant="secondary"
            className="tabular h-11 px-0 text-sm"
            aria-label={`${d > 0 ? `+${d}` : d} min`}
            onClick={() => setTime((t) => shiftTime(t, d))}
          >
            {d > 0 ? `+${d}` : `−${Math.abs(d)}`}
            <span className="-ml-1 text-xs font-normal text-muted-foreground">min</span>
          </Button>
        ))}
      </div>

      <div>
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">Quick pick</div>
        <div className="grid grid-cols-4 gap-1.5">
          {picks.map((t, i) => {
            const isNow = props.nowTime && i === 0;
            const selected = t === time;
            return (
              <button
                key={`${i}-${t}`}
                type="button"
                onClick={() => setTime(t)}
                aria-pressed={selected}
                className={cn(
                  "tabular flex h-11 flex-col items-center justify-center rounded-lg text-sm font-medium whitespace-nowrap transition-colors",
                  selected ? "bg-foreground text-background" : "bg-card shadow-surface hover:bg-muted",
                )}
              >
                {isNow ? (
                  <>
                    <span className="leading-4">Now</span>
                    <span className={cn("text-2xs leading-3 font-normal", selected ? "text-background/70" : "text-muted-foreground")}>{formatTime12(t)}</span>
                  </>
                ) : (
                  formatTime12(t)
                )}
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 py-1.5 pr-1.5 pl-3.5">
        <span className="text-sm text-muted-foreground">Exact time</span>
        <input
          type="time"
          value={time}
          onChange={(e) => isValidTime(e.target.value) && setTime(e.target.value)}
          className="tabular h-10 rounded-lg border border-input bg-card px-3 text-base focus-visible:border-primary focus-visible:outline-none"
          aria-label="Exact time"
        />
      </label>

      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-absent-soft px-3 py-2.5 text-sm font-medium text-absent">
          <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
        </p>
      )}

      <DialogFooter className="flex-row gap-2 [&>button]:h-12 sm:[&>button]:h-11">
        {props.onClear ? (
          <Button type="button" variant="ghost" className="flex-1 text-absent hover:bg-absent-soft hover:text-absent" onClick={props.onClear}>
            {props.clearLabel ?? "Clear"}
          </Button>
        ) : (
          <Button type="button" variant="outline" className="flex-1" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
        )}
        <Button type="button" className="flex-[2] text-base" disabled={!!error} onClick={() => props.onConfirm(time)}>
          {props.confirmLabel} {formatTime12(time)}
        </Button>
      </DialogFooter>
    </>
  );
}
