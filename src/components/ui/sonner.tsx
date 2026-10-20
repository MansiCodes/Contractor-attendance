"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Toaster as Sonner, type ToasterProps } from "sonner"

/** Quiet, compact notifications: white card, coloured icon, never a coloured slab. */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      position="top-center"
      gap={8}
      offset={12}
      mobileOffset={{ top: 12, left: 12, right: 12 }}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4.5 text-present" />,
        info: <InfoIcon className="size-4.5 text-primary" />,
        warning: <TriangleAlertIcon className="size-4.5 text-pending" />,
        error: <OctagonXIcon className="size-4.5 text-absent" />,
        loading: <Loader2Icon className="size-4.5 animate-spin text-muted-foreground" />,
      }}
      toastOptions={{
        classNames: {
          toast: "!rounded-xl !border-0 !shadow-raised !font-sans !gap-2.5 !py-3 !px-3.5",
          title: "!text-sm !font-medium !leading-5",
          description: "!text-xs !text-muted-foreground",
          actionButton: "!h-8 !rounded-lg !bg-primary !px-3 !text-xs !font-semibold",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "transparent",
          "--border-radius": "0.75rem",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
