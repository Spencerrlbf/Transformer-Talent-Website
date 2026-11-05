import type { Metadata } from "next";
import ApplyForm from "@/components/ApplyForm";

export const metadata: Metadata = {
  title: "Apply",
  description: "Send us your resume once and we will keep it on file for the searches we run.",
};

export default function ApplyPage() {
  return (
    <main className="page">
      <div className="wrap">
        <div className="b1" style={{ paddingTop: "1.6rem" }}>
          <aside className="apply-rail-solo">
            <ApplyForm roles={[]} speculative />
          </aside>
        </div>
      </div>
    </main>
  );
}
