"use client";
// Cloudflare Turnstile widget for the public forms. Renders nothing when
// NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset (captcha off). Placed inside a
// <form>, the widget injects a hidden cf-turnstile-response input, so every
// FormData submit carries the token without extra wiring; JSON callers read
// the same field off their FormData. Tokens are single-use, so submit
// handlers call resetTurnstile(form) once a response lands.
import { useEffect, useRef } from "react";

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (widget?: string | HTMLElement) => void;
  remove: (widget: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __ttTurnstileLoad?: Promise<void>;
  }
}

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!window.__ttTurnstileLoad) {
    window.__ttTurnstileLoad = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve();
      // Script blocked or offline: resolve anyway; the form posts without a
      // token and the server decides (it only rejects when captcha is on).
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });
  }
  return window.__ttTurnstileLoad;
}

/** Mint fresh tokens for every widget inside `scope` (tokens are single-use). */
export function resetTurnstile(scope?: HTMLElement | null) {
  const t = window.turnstile;
  if (!t) return;
  (scope ?? document).querySelectorAll<HTMLElement>(".ts-box").forEach((box) => {
    try {
      t.reset(box);
    } catch {
      /* widget already gone */
    }
  });
}

export default function Turnstile() {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!SITE_KEY || !el) return;
    let id: string | null = null;
    let gone = false;
    loadScript().then(() => {
      if (gone || !window.turnstile || !el) return;
      id = window.turnstile.render(el, {
        sitekey: SITE_KEY,
        appearance: "interaction-only",
        "refresh-expired": "auto",
        "response-field-name": "cf-turnstile-response",
      });
    });
    return () => {
      gone = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, []);

  if (!SITE_KEY) return null;
  return <div ref={box} className="ts-box" />;
}
