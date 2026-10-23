// Offline read boundary; a test must install its synthetic response explicitly.
let read: (resource: string) => Promise<Response> = async () => { throw new Error('unconfigured synthetic read'); };
export function setRead(next: typeof read) { read = next; }
export function sbRest(resource: string) { return read(resource); }
