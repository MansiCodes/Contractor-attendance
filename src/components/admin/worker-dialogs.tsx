"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeftRight, Loader2, MoreHorizontal, Pencil, Plus, UserCheck, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createWorkerAction,
  deactivateWorkerAction,
  reactivateWorkerAction,
  transferWorkerAction,
  updateWorkerAction,
} from "@/lib/server/actions/admin";
import { workerCreate, workerUpdate } from "@/lib/domain/schemas";
import { Field, selectClass, useServerAction } from "./form-bits";

export interface Option {
  id: string;
  name: string;
}

export interface DeploymentOptions {
  contractors: Option[];
  projects: Option[];
  /** contractorId -> project ids where that contractor is currently assigned */
  sitesByContractor: Record<string, string[]>;
  today: string;
}

type CreateValues = z.input<typeof workerCreate>;

export function AddWorkerDialog({ options, defaultContractorId, defaultProjectId }: { options: DeploymentOptions; defaultContractorId?: string; defaultProjectId?: string }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const { pending, run } = useServerAction();
  const initialContractor = defaultContractorId ?? options.contractors[0]?.id ?? "";
  const sitesFor = (c: string) => options.projects.filter((p) => options.sitesByContractor[c]?.includes(p.id));
  const defaults = (): CreateValues => ({
    fullName: "",
    contractorId: initialContractor,
    projectId: defaultProjectId && sitesFor(initialContractor).some((p) => p.id === defaultProjectId) ? defaultProjectId : sitesFor(initialContractor)[0]?.id ?? "",
    startDate: options.today,
    phone: "",
    notes: "",
  });
  const form = useForm<CreateValues, unknown, z.output<typeof workerCreate>>({ resolver: zodResolver(workerCreate), defaultValues: defaults() });
  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch is fine here
  const contractorId = form.watch("contractorId");
  const sites = sitesFor(contractorId);
  const [addAnother, setAddAnother] = useState(false);

  const submit = form.handleSubmit((v) =>
    run(() => createWorkerAction(v), {
      success: (w) => `${w.fullName} added as ${w.code}`,
      onSuccess: () => {
        if (addAnother) form.reset({ ...v, fullName: "", phone: "", notes: "" });
        else {
          setOpen(false);
          form.reset(defaults());
        }
      },
    }),
  );

  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="add-worker">
        <Plus /> Add worker
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add worker</DialogTitle>
            <DialogDescription>Only the name and site are needed. A worker ID is created automatically.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4" noValidate>
            <Field label="Full name" htmlFor="w-name" error={form.formState.errors.fullName?.message}>
              <Input id="w-name" autoComplete="off" {...form.register("fullName")} />
            </Field>
            <Field label="Contractor" htmlFor="w-contractor" error={form.formState.errors.contractorId?.message}>
              <select
                id="w-contractor"
                className={selectClass}
                {...form.register("contractorId", {
                  onChange: (e) => form.setValue("projectId", sitesFor(e.target.value)[0]?.id ?? ""),
                })}
              >
                {options.contractors.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field
              label="Project site"
              htmlFor="w-project"
              error={form.formState.errors.projectId?.message}
              hint={sites.length === 0 ? "This contractor is not assigned to any project yet. Assign it under Projects." : undefined}
            >
              <select id="w-project" className={selectClass} disabled={sites.length === 0} {...form.register("projectId")}>
                {sites.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Starts on" htmlFor="w-start" error={form.formState.errors.startDate?.message}>
              <Input id="w-start" type="date" {...form.register("startDate")} />
            </Field>
            {more ? (
              <>
                <Field label="Phone (optional)" htmlFor="w-phone">
                  <Input id="w-phone" type="tel" inputMode="tel" {...form.register("phone")} />
                </Field>
                <Field label="Notes (optional)" htmlFor="w-notes">
                  <Textarea id="w-notes" rows={2} {...form.register("notes")} />
                </Field>
              </>
            ) : (
              <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md text-sm font-medium text-primary hover:underline" onClick={() => setMore(true)}>
                <Plus className="size-3.5" /> Phone or notes (optional)
              </button>
            )}
            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-muted-foreground">
              <input type="checkbox" className="size-4.5 accent-primary" checked={addAnother} onChange={(e) => setAddAnother(e.target.checked)} />
              Keep this open to add another
            </label>
            <DialogFooter>
              <Button type="submit" disabled={pending || sites.length === 0} data-testid="save-worker">
                {pending && <Loader2 className="animate-spin" />} Save worker
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export interface WorkerSummary {
  id: string;
  code: string;
  fullName: string;
  contractorId: string;
  isActive: boolean;
  phone: string | null;
  notes: string | null;
  currentProjectId: string | null;
  currentSince: string | null;
}

type Mode = "edit" | "transfer" | "deactivate" | "reactivate" | null;

export function WorkerActions({ worker, options }: { worker: WorkerSummary; options: DeploymentOptions }) {
  const [mode, setMode] = useState<Mode>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label={`Actions for ${worker.fullName}`}>
            <MoreHorizontal className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setMode("edit")}>
            <Pencil /> Edit details
          </DropdownMenuItem>
          {worker.isActive ? (
            <>
              <DropdownMenuItem onSelect={() => setMode("transfer")}>
                <ArrowLeftRight /> Transfer to another site
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setMode("deactivate")}>
                <UserX /> Deactivate
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onSelect={() => setMode("reactivate")}>
              <UserCheck /> Reactivate
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {mode === "edit" && <EditWorker worker={worker} onClose={() => setMode(null)} />}
      {mode === "transfer" && <TransferWorker worker={worker} options={options} onClose={() => setMode(null)} />}
      {mode === "deactivate" && <DeactivateWorker worker={worker} today={options.today} onClose={() => setMode(null)} />}
      {mode === "reactivate" && <ReactivateWorker worker={worker} options={options} onClose={() => setMode(null)} />}
    </>
  );
}

function EditWorker({ worker, onClose }: { worker: WorkerSummary; onClose: () => void }) {
  const { pending, run } = useServerAction();
  const form = useForm<z.input<typeof workerUpdate>, unknown, z.output<typeof workerUpdate>>({
    resolver: zodResolver(workerUpdate),
    defaultValues: { fullName: worker.fullName, phone: worker.phone ?? "", notes: worker.notes ?? "" },
  });
  const submit = form.handleSubmit((v) => run(() => updateWorkerAction(worker.id, v), { success: "Worker updated", onSuccess: onClose }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {worker.code}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Full name" htmlFor="we-name" error={form.formState.errors.fullName?.message}>
            <Input id="we-name" {...form.register("fullName")} />
          </Field>
          <Field label="Phone (optional)" htmlFor="we-phone">
            <Input id="we-phone" type="tel" {...form.register("phone")} />
          </Field>
          <Field label="Notes (optional)" htmlFor="we-notes">
            <Textarea id="we-notes" rows={2} {...form.register("notes")} />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TransferWorker({ worker, options, onClose }: { worker: WorkerSummary; options: DeploymentOptions; onClose: () => void }) {
  const { pending, run } = useServerAction();
  const [contractorId, setContractorId] = useState(worker.contractorId);
  const sites = options.projects.filter((p) => options.sitesByContractor[contractorId]?.includes(p.id));
  const [projectId, setProjectId] = useState(sites.find((p) => p.id !== worker.currentProjectId)?.id ?? sites[0]?.id ?? "");
  const [date, setDate] = useState(options.today);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer {worker.fullName}</DialogTitle>
          <DialogDescription>
            Past attendance stays with the current site. From the chosen date the worker appears on the new site&apos;s register.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Contractor" htmlFor="t-contractor">
            <select
              id="t-contractor"
              className={selectClass}
              value={contractorId}
              onChange={(e) => {
                setContractorId(e.target.value);
                setProjectId(options.projects.find((p) => options.sitesByContractor[e.target.value]?.includes(p.id))?.id ?? "");
              }}
            >
              {options.contractors.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="New project site" htmlFor="t-project">
            <select id="t-project" className={selectClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {sites.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.id === worker.currentProjectId ? " (current)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effective from" htmlFor="t-date" hint={worker.currentSince ? `Current assignment started ${worker.currentSince}` : undefined}>
            <Input id="t-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button
            disabled={pending || !projectId}
            onClick={() => run(() => transferWorkerAction(worker.id, { projectId, contractorId, effectiveDate: date }), { success: "Worker transferred", onSuccess: onClose })}
          >
            Transfer worker
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeactivateWorker({ worker, today, onClose }: { worker: WorkerSummary; today: string; onClose: () => void }) {
  const { pending, run } = useServerAction();
  const [date, setDate] = useState(today);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deactivate {worker.fullName}?</DialogTitle>
          <DialogDescription>
            The worker will no longer appear on registers after the last working date. Their attendance history is kept.
          </DialogDescription>
        </DialogHeader>
        <Field label="Last working date" htmlFor="d-date">
          <Input id="d-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => run(() => deactivateWorkerAction(worker.id, { lastWorkingDate: date }), { success: "Worker deactivated", onSuccess: onClose })}
          >
            Deactivate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReactivateWorker({ worker, options, onClose }: { worker: WorkerSummary; options: DeploymentOptions; onClose: () => void }) {
  const { pending, run } = useServerAction();
  const sites = options.projects.filter((p) => options.sitesByContractor[worker.contractorId]?.includes(p.id));
  const [projectId, setProjectId] = useState(sites[0]?.id ?? "");
  const [date, setDate] = useState(options.today);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reactivate {worker.fullName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Project site" htmlFor="r-project">
            <select id="r-project" className={selectClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {sites.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Starts on" htmlFor="r-date">
            <Input id="r-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button
            disabled={pending || !projectId}
            onClick={() => run(() => reactivateWorkerAction(worker.id, { projectId, startDate: date }), { success: "Worker reactivated", onSuccess: onClose })}
          >
            Reactivate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
