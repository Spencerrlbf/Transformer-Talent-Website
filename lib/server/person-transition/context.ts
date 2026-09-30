import { AsyncLocalStorage } from 'node:async_hooks';

export type TransitionAdmission = Readonly<{
  status: 'admitted';
  workId: string;
  token: string;
  generation: number;
  leaseUntil: string;
}>;
const context = new AsyncLocalStorage<TransitionAdmission>();
export const transitionUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

/** Explicit opt-in only. Missing schema is tolerated only when support is off. */
export function transitionSupport(): boolean {
  const value = process.env.PERSON_TRANSITION_SUPPORT;
  if (value === undefined || value === 'off') return false;
  if (value === 'on') return true;
  throw Error('transition_configuration');
}

/** Server-owned context only: never accept this object from an HTTP request. */
export function withTransitionWork<T>(admission: TransitionAdmission, fn: () => T): T {
  if (!transitionSupport() || admission.status !== 'admitted' ||
      !transitionUuid(admission.workId) || !transitionUuid(admission.token) ||
      !Number.isSafeInteger(admission.generation) || admission.generation < 0 ||
      !Number.isFinite(Date.parse(admission.leaseUntil))) throw Error('transition_admission');
  return context.run(Object.freeze({ ...admission }), fn);
}

export function transitionRequestHeaders(): Record<string, string> {
  const admission = context.getStore();
  return admission ? { 'x-person-work-id': admission.workId, 'x-person-work-token': admission.token } : {};
}

/** Caller must BEGIN before binding, and bind before taking family/business locks. */
export async function bindTransitionWork(client: { query: (sql: string, values?: string[]) => Promise<unknown> }): Promise<void> {
  const admission = context.getStore();
  if (!admission) {
    if (transitionSupport()) throw Error('transition_admission');
    return;
  }
  await client.query("select set_config('person.work_id',$1,true),set_config('person.work_token',$2,true)",
    [admission.workId, admission.token]);
}
