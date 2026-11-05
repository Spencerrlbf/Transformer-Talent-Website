import { redirect } from "next/navigation";

// The matcher needs the matching service, which is off while the project is paused.
export default function TalentPage() {
  redirect("/apply");
}
