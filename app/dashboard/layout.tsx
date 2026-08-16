import type { Metadata } from "next";
import DashShell from "@/components/dashboard/DashShell";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false, follow: false },
};

export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <DashShell>{children}</DashShell>;
}
