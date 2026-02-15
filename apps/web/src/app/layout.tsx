import type { Metadata } from "next";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "TargetGraph",
  description:
    "Live disease-target-drug-pathway graph with hypothesis scoring and evidence-grounded narrative.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        <Toaster richColors closeButton />
      </body>
    </html>
  );
}
