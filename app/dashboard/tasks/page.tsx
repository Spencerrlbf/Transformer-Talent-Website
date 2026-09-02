import { redirect } from "next/navigation";

// Tasks folded into the Inbox (dated work lives under its Upcoming view).
// Old links and bookmarks land there.
export default function TasksPage() {
  redirect("/dashboard/inbox");
}
