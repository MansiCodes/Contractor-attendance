"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Camera, IndianRupee, Loader2, MapPin, MoreHorizontal, Pencil, Plus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { createContractorAction, updateContractorAction, uploadContractorPhotoAction } from "@/lib/server/actions/admin";
import { setContractorIdentityAction } from "@/lib/server/actions/import";
import { contractorInput } from "@/lib/domain/schemas";
import { Field, ToggleRow, useServerAction } from "./form-bits";

type Values = z.input<typeof contractorInput>;

export function AddContractorDialog() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { pending, run } = useServerAction();
  const form = useForm<Values>({ resolver: zodResolver(contractorInput), defaultValues: { name: "", location: "" } });
  const submit = form.handleSubmit((v) =>
    run(() => createContractorAction(v), {
      success: "Contractor added",
      onSuccess: (id) => {
        setOpen(false);
        form.reset();
        router.push(`/admin/contractors/${id}`);
      },
    }),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add contractor
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add contractor</DialogTitle>
          <DialogDescription>You can add a photo and payment rules after saving.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Contractor name" htmlFor="c-name" error={form.formState.errors.name?.message}>
            <Input id="c-name" autoComplete="off" {...form.register("name")} />
          </Field>
          <Field label="Location (optional)" htmlFor="c-loc" hint="City, State" error={form.formState.errors.location?.message}>
            <Input id="c-loc" autoComplete="off" {...form.register("location")} />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save contractor
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditContractorDialog({ contractor }: { contractor: { id: string; name: string; location: string | null; isActive: boolean } }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(contractor.isActive);
  const { pending, run } = useServerAction();
  const form = useForm<Values>({ resolver: zodResolver(contractorInput), defaultValues: { name: contractor.name, location: contractor.location ?? "" } });
  const submit = form.handleSubmit((v) =>
    run(() => updateContractorAction(contractor.id, { ...v, isActive: active }), { success: "Contractor updated", onSuccess: () => setOpen(false) }),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Pencil /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit contractor</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Contractor name" htmlFor="ce-name" error={form.formState.errors.name?.message}>
            <Input id="ce-name" {...form.register("name")} />
          </Field>
          <Field label="Location (optional)" htmlFor="ce-loc" error={form.formState.errors.location?.message}>
            <Input id="ce-loc" {...form.register("location")} />
          </Field>
          <ToggleRow label="Active" description="Inactive contractors are hidden from new assignments." checked={active} onCheckedChange={setActive} />
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Downscales the image in the browser (max 512px JPEG) so uploads stay small on mobile data. */
async function downscale(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85));
  } catch {
    return file;
  }
}

/** Camera button that sits on the contractor's avatar. */
export function PhotoUploadButton({ contractorId, hasPhoto }: { contractorId: string; hasPhoto?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { pending, run } = useServerAction();
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        data-testid="photo-input"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          if (!file.type.startsWith("image/")) return toast.error("Please choose an image file");
          const blob = await downscale(file);
          const fd = new FormData();
          fd.set("contractorId", contractorId);
          fd.set("photo", new File([blob], "photo.jpg", { type: blob.type || file.type }));
          run(() => uploadContractorPhotoAction(fd), { success: "Photo updated" });
        }}
      />
      <button
        type="button"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
        aria-label={hasPhoto ? "Change photo" : "Add photo"}
        className="absolute -right-1.5 -bottom-1.5 grid size-8 place-items-center rounded-full bg-card text-foreground shadow-raised transition-transform hover:scale-105 active:scale-95 disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
      </button>
    </>
  );
}

/** Discreet management menu on each contractor card. */
export function ContractorMenu({ contractorId, name }: { contractorId: string; name: string }) {
  const base = `/admin/contractors/${contractorId}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1.5 text-muted-foreground" aria-label={`Manage ${name}`}>
          <MoreHorizontal className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`${base}?tab=workers`}>
            <Users /> Workers
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`${base}?tab=plants`}>
            <MapPin /> Plants
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`${base}?tab=rules`}>
            <IndianRupee /> Payment rules
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Shown while a contractor's identity is unconfirmed (e.g. an imported wage sheet
 * whose name and heading disagree). Confirming changes nothing but the status:
 * contractors are never merged automatically.
 */
export function IdentityReviewBanner({ contractor }: { contractor: { id: string; name: string; legalName: string | null; identityNote: string | null } }) {
  const [open, setOpen] = useState(false);
  const [legalName, setLegalName] = useState(contractor.legalName ?? "");
  const [note, setNote] = useState("");
  const { pending, run } = useServerAction();
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-xl border border-pending/30 bg-pending-soft p-4 text-sm" role="note" data-testid="identity-review">
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-pending">Contractor identity needs review</p>
        <p className="mt-0.5">{contractor.identityNote ?? "Confirm who this contractor is before relying on its records."}</p>
      </div>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Review
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm {contractor.name}</DialogTitle>
            <DialogDescription>
              Confirm only after checking with the contractor or HR. If this is really a different contractor, leave it under review and correct the records instead. Nothing is merged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Legal name (as on their documents)" htmlFor="id-legal">
              <Input id="id-legal" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
            </Field>
            <Field label="How it was confirmed" htmlFor="id-note" hint="e.g. “Same firm – confirmed with HR on 24 Oct”">
              <Input id="id-note" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <DialogFooter>
            <Button
              disabled={pending || note.trim().length < 3}
              onClick={() =>
                run(() => setContractorIdentityAction(contractor.id, { identityStatus: "confirmed", legalName, identityNote: note }), {
                  success: "Contractor identity confirmed",
                  onSuccess: () => setOpen(false),
                })
              }
            >
              {pending && <Loader2 className="animate-spin" />} Confirm identity
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
