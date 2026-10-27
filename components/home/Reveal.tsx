"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Marks its wrapper once it scrolls into view so CSS can draw a demo in.
// The server HTML carries no attribute, so without JavaScript the drawing is
// simply shown complete. An IntersectionObserver decides on its first
// callback: already on screen means data-visible at once (nothing is ever
// blanked), off screen means data-reveal="pending" (the CSS holds the strokes
// at zero) until the wrapper scrolls in, then data-visible="true" and the
// observer disconnects. Nothing else runs; the animation itself is CSS.

export default function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let decided = false;
    const io = new IntersectionObserver(
      (entries) => {
        const onScreen = entries.some((e) => e.isIntersecting);
        if (!decided) {
          decided = true;
          if (!onScreen) {
            el.dataset.reveal = "pending";
            return;
          }
        }
        if (!onScreen) return;
        el.dataset.visible = "true";
        io.disconnect();
      },
      { rootMargin: "0px 0px -20% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
