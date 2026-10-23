// Test boundary for Next's response callback; no server or provider is invoked.
export const NextRequest = Request;
export const NextResponse = { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) };
export function after(fn: () => Promise<void>) {
  ((globalThis as unknown as { acceptanceCallbacks: (() => Promise<void>)[] }).acceptanceCallbacks).push(fn);
}
