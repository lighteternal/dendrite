import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dendrite",
  description:
    "Live disease-target-drug-pathway graph with hypothesis scoring and evidence-grounded narrative.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        <Toaster richColors closeButton />
        <Analytics />
      </body>
    </html>
  );
}
