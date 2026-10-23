// Next.js server start hook. Installs the denied-transport guard before any
// route or worker code can call a provider (lib/server/outbound-guard.ts).
// Production leaves OUTBOUND_DENY_HOSTS unset, so nothing is installed there.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installOutboundGuard } = await import("./lib/server/outbound-guard");
    installOutboundGuard();
  }
}
