import { redirect } from "next/navigation";

// The old /companies content now lives on /about (how we work) and
// /talent (instant match). Preserve inbound links.
export default function CompaniesPage() {
  redirect("/about");
}
