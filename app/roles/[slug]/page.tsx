import { permanentRedirect } from "next/navigation";

// Individual role pages are gone while the project is paused.
export default function RolePage() {
  permanentRedirect("/roles");
}
