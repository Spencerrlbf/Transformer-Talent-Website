// Trial-only role selection. Kept separate from the live Harvest mapper during storage rollout.
export const SIDE_ROLE = /\b((?<!founding\s)member(?!\s+(of\s+(the\s+)?(technical|engineering|research|professional)\s+staff|software|technical|engineering))|membership|advisor|advisory|board|mentor|mentoring|volunteer|ambassador|investor|council)\b/i;
/** A title that names a job ("Product Director", "AVP", "Principal"): a side
 *  word in it ("... Membership", "... Advisory") is a department or a
 *  product, not a seat, unless it also names a board seat. */
const JOB_NOUN = /\b(engineer(ing)?|developer|programmer|architect|scientist|researcher|analyst|designer|director|manager|principal|lead|head|chief|officer|president|vp|svp|evp|avp|ceo|cto|cfo|coo|cio|ciso|cpo|founder|co-?founder|partner|owner|consultant|specialist|associate|coordinator|administrator|strategist|recruiter|intern|professor|lecturer|teacher|attorney|counsel|accountant|technician)\b/i;
const BOARD_SEAT = /\b(board\s+(member|director|advisor|adviser|observer|chair)|member\s+of\s+the\s+board|(advisory|executive)\s+board|board\s+of\s+(directors|advisors|advisers|trustees|governors))\b/i;
/** A body that is itself a board or council, named only as the employer. */
const SIDE_BODY = /\b(council|advisory\s+board|board\s+of\s+(directors|advisors|advisers|trustees|governors))\b/i;
/** Is this position a membership or side role rather than the job? Judged on
 *  the title: an employer's name ("Mentor Graphics", "The College Board",
 *  "BARR Advisory") never makes a job a side role. A title that names a job
 *  is a side role only when it names a board seat too. With no title, an
 *  employer that is itself a council or board is a side role. */
export function isSideRoleTitle(title: string | null | undefined, company?: string | null): boolean {
  const t = (title ?? "").trim();
  if (!t) return SIDE_BODY.test(company ?? "");
  if (!SIDE_ROLE.test(t)) return false;
  return !JOB_NOUN.test(t) || BOARD_SEAT.test(t);
}
/** The side words that never name the job itself. An adviser title ("Senior
 *  Policy Advisor") can be a full-time job, so it is not among them. */
const CLEAR_SIDE = /\b((?<!founding\s)member(?!\s+(of\s+(the\s+)?(technical|engineering|research|professional)\s+staff|software|technical|engineering))|membership|board|mentor|mentoring|volunteer|ambassador|investor|council)\b/i;
/** A side role that is clearly not the job (a board seat, a membership,
 *  mentoring, volunteering): only such a current position is ever put below
 *  an ended job. */
export function isClearSideRoleTitle(title: string | null | undefined, company?: string | null): boolean {
  const t = (title ?? "").trim();
  return isSideRoleTitle(title, company) && (!t || CLEAR_SIDE.test(t));
}

/** Where the person's real job sits: the first current position that is not
 *  a side role; else the first current one that is not clearly a side role
 *  (an adviser title may be the job); else the latest that is not a side
 *  role (someone between jobs keeps their last real title). -1 when none. */
export function realJobIndex<T extends { is_current: boolean }>(positions: T[], side: (p: T) => boolean, clearlySide: (p: T) => boolean): number {
  let job = positions.findIndex((p) => p.is_current && !side(p));
  if (job < 0) job = positions.findIndex((p) => p.is_current && !clearlySide(p));
  if (job < 0) job = positions.findIndex((p) => !side(p));
  return job;
}
