import { redirect } from "next/navigation";

// The old /companies page's content now lives on /process (how we work,
// FAQ, fees) and /talent (instant match). Preserve inbound links.
export default function CompaniesPage() {
  redirect("/process");
}
