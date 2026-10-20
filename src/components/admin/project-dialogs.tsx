"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  addContractorToProjectAction,
  createOperatorAction,
  createProjectAction,
  removeContractorFromProjectAction,
  setOperatorAccessAction,
  setOperatorActiveAction,
  updateProjectAction,
} from "@/lib/server/actions/admin";
import { operatorCreate, projectInput } from "@/lib/domain/schemas";
import type { Project } from "@/lib/domain/types";
import { Field, ToggleRow, selectClass, useServerAction } from "./form-bits";

type ProjectValues = z.input<typeof projectInput>;

const TIMEZONES = ["Asia/Kolkata"];

export function AddProjectDialog() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { pending, run } = useServerAction();
  const form = useForm<ProjectValues>({
    resolver: zodResolver(projectInput),
    defaultValues: { name: "", location: "", isActive: true, timezone: "Asia/Kolkata", defaultCheckIn: "09:00", allowOvernight: false, operatorBackdateDays: 0 },
  });
  const submit = form.handleSubmit((v) =>
    run(() => createProjectAction(v), {
      success: "Project created",
      onSuccess: (id) => {
        setOpen(false);
        form.reset();
        router.push(`/admin/projects/${id}`);
      },
    }),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add project site</DialogTitle>
          <DialogDescription>Assign contractors, workers and operators after saving.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Project name" htmlFor="p-name" error={form.formState.errors.name?.message}>
            <Input id="p-name" {...form.register("name")} />
          </Field>
          <Field label="Location" htmlFor="p-loc" hint="City, State" error={form.formState.errors.location?.message}>
            <Input id="p-loc" {...form.register("location")} />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectSettingsForm({ project }: { project: Project }) {
  const { pending, run } = useServerAction();
  const form = useForm<ProjectValues>({
    resolver: zodResolver(projectInput),
    defaultValues: {
      name: project.name,
      location: project.location,
      isActive: project.isActive,
      timezone: project.timezone,
      defaultCheckIn: project.defaultCheckIn,
      allowOvernight: project.allowOvernight,
      operatorBackdateDays: project.operatorBackdateDays,
    },
  });
  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch is fine here
  const [isActive, allowOvernight] = form.watch(["isActive", "allowOvernight"]);
  const e = form.formState.errors;
  const submit = form.handleSubmit((v) => run(() => updateProjectAction(project.id, v), { success: "Project settings saved" }));
  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl bg-card p-4 shadow-surface" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Project name" htmlFor="ps-name" error={e.name?.message}>
          <Input id="ps-name" {...form.register("name")} />
        </Field>
        <Field label="Location" htmlFor="ps-loc" error={e.location?.message}>
          <Input id="ps-loc" {...form.register("location")} />
        </Field>
        <Field label="Suggested IN time" htmlFor="ps-in" hint="Shown for pending workers. Not counted until confirmed." error={e.defaultCheckIn?.message}>
          <Input id="ps-in" type="time" {...form.register("defaultCheckIn")} />
        </Field>
        <Field label="Timezone" htmlFor="ps-tz">
          <select id="ps-tz" className={selectClass} {...form.register("timezone")}>
            {TIMEZONES.map((t) => (
              <option key={t} value={t}>{t === "Asia/Kolkata" ? "India (IST, Asia/Kolkata)" : t}</option>
            ))}
          </select>
        </Field>
        <Field label="Operators may edit past days" htmlFor="ps-back" hint="0 = today only. Admins can always correct." error={e.operatorBackdateDays?.message}>
          <select id="ps-back" className={selectClass} {...form.register("operatorBackdateDays")}>
            {[0, 1, 2, 3, 7].map((n) => (
              <option key={n} value={n}>{n === 0 ? "Today only" : `Up to ${n} day${n > 1 ? "s" : ""} back`}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <ToggleRow
          label="Allow overnight shifts"
          description="An OUT time earlier than IN is treated as the next day."
          checked={!!allowOvernight}
          onCheckedChange={(v) => form.setValue("allowOvernight", v, { shouldDirty: true })}
        />
        <ToggleRow
          label="Site active"
          description="Inactive sites are hidden from operators."
          checked={!!isActive}
          onCheckedChange={(v) => form.setValue("isActive", v, { shouldDirty: true })}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Save settings
        </Button>
      </div>
    </form>
  );
}

export function AssignContractor({ projectId, options }: { projectId: string; options: { id: string; name: string }[] }) {
  const { pending, run } = useServerAction();
  const [contractorId, setContractorId] = useState(options[0]?.id ?? "");
  if (options.length === 0) return null;
  return (
    <div className="flex gap-2">
      <select className={selectClass} value={contractorId} onChange={(e) => setContractorId(e.target.value)} aria-label="Contractor to assign">
        {options.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <Button
        variant="outline"
        className="h-11 shrink-0"
        disabled={pending || !contractorId}
        onClick={() => run(() => addContractorToProjectAction({ contractorId, projectId }), { success: "Contractor assigned to project" })}
      >
        <Plus /> Assign
      </Button>
    </div>
  );
}

export function RemoveContractorButton({ assignmentId, name }: { assignmentId: string; name: string }) {
  const { pending, run } = useServerAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:bg-absent-soft hover:text-absent"
        disabled={pending}
        aria-label={`Remove ${name} from this project`}
        onClick={() => setOpen(true)}
      >
        <X className="size-4" />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End {name}&apos;s assignment?</AlertDialogTitle>
            <AlertDialogDescription>
              From today, {name} no longer appears on this project&apos;s register. Past attendance is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => run(() => removeContractorFromProjectAction({ assignmentId }), { success: "Contractor assignment ended" })}
            >
              End assignment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function OperatorAccessToggle({ operatorId, projectId, granted, label }: { operatorId: string; projectId: string; granted: boolean; label: string }) {
  const router = useRouter();
  // Flip immediately; the server result (or an error) settles the real value.
  const [checked, setChecked] = useOptimistic(granted);
  const [pending, start] = useTransition();
  return (
    <label className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50">
      <input
        type="checkbox"
        className="size-5 shrink-0 accent-primary"
        checked={checked}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          start(async () => {
            setChecked(next);
            try {
              const res = await setOperatorAccessAction({ operatorId, projectId, granted: next });
              if (res.ok) toast.success(next ? "Access granted" : "Access removed");
              else toast.error(res.error);
            } catch {
              toast.error("Could not reach the server. Check your connection and try again.");
            }
            router.refresh();
          });
        }}
      />
      <span className="min-w-0 text-sm">{label}</span>
    </label>
  );
}

export function OperatorActiveToggle({ profileId, isActive }: { profileId: string; isActive: boolean }) {
  const { pending, run } = useServerAction();
  return (
    <Button
      variant="outline"
      size="sm"
      className={isActive ? "text-absent" : undefined}
      disabled={pending}
      onClick={() => run(() => setOperatorActiveAction({ profileId, isActive: !isActive }), { success: isActive ? "Operator deactivated" : "Operator reactivated" })}
    >
      {isActive ? "Deactivate" : "Reactivate"}
    </Button>
  );
}

type OperatorValues = z.input<typeof operatorCreate>;

export function AddOperatorDialog({ live }: { live: boolean }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useServerAction();
  const form = useForm<OperatorValues>({ resolver: zodResolver(operatorCreate), defaultValues: { fullName: "", email: "", password: "" } });
  const e = form.formState.errors;
  const submit = form.handleSubmit((v) =>
    run(() => createOperatorAction(live ? v : { fullName: v.fullName, email: v.email }), {
      success: "Operator added. Now grant access to their sites.",
      onSuccess: () => {
        setOpen(false);
        form.reset();
      },
    }),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add operator
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add attendance operator</DialogTitle>
          <DialogDescription>
            {live ? "Creates a sign-in account. Share the email and temporary password with the operator; they can change it after signing in." : "Demo mode: creates a demo operator you can sign in as."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Name" htmlFor="o-name" error={e.fullName?.message}>
            <Input id="o-name" {...form.register("fullName")} />
          </Field>
          <Field label="Email" htmlFor="o-email" error={e.email?.message}>
            <Input id="o-email" type="email" {...form.register("email")} />
          </Field>
          {live && (
            <Field label="Temporary password" htmlFor="o-pw" hint="At least 8 characters" error={e.password?.message}>
              <Input id="o-pw" type="text" autoComplete="off" {...form.register("password")} />
            </Field>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Add operator
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
