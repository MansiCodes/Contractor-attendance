import type { Metadata, Viewport } from "next";
import { Geist, Noto_Sans_Devanagari } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
// Loaded on demand (unicode-range) only when Devanagari text appears.
const notoDevanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-devanagari",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: { default: "NF Attendance Register", template: "%s · NF Attendance" },
  description: "Contractor labour attendance register for NF project sites",
  applicationName: "NF Attendance",
  appleWebApp: { capable: true, title: "NF Attendance", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f7f6f3",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${geist.variable} ${notoDevanagari.variable}`}>
      <body className="min-h-dvh">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
