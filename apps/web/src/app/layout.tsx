import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { ZebProvider } from "@/providers/ZebProvider";
import { ToastProvider } from "@/providers/ToastProvider";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: { default: "Zeb Scan — Pay in ZEC. They get INR.", template: "%s · Zeb Scan" },
  description:
    "Zeb Scan connects Zcash payments to local INR settlement experiences: Scan & Pay any supported UPI QR, a merchant QR terminal, and shareable payment links with shielded settlement.",
  applicationName: "Zeb Scan",
  keywords: ["Zeb Scan", "ZEC", "Zcash", "UPI", "INR", "merchant payments", "payment links", "shielded payments", "Noir wallet"],
  openGraph: {
    title: "Zeb Scan — Pay in ZEC. They get INR.",
    description: "Scan & Pay, merchant QR terminal and payment links for Zcash payments with local INR settlement.",
    siteName: "Zeb Scan",
    type: "website",
    locale: "en_IN",
  },
  twitter: { card: "summary_large_image", title: "Zeb Scan — Pay in ZEC. They get INR." },
};

export const viewport: Viewport = {
  themeColor: "#F4F2EB",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>
      <body className="theme-light min-h-screen">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-input focus:bg-gold focus:px-3 focus:py-2 focus:text-ink"
        >
          Skip to content
        </a>
        <ZebProvider>
          <ToastProvider>{children}</ToastProvider>
        </ZebProvider>
      </body>
    </html>
  );
}
