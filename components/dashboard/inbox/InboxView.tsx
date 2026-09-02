"use client";
// The Inbox list: every communication owed today, in sections by the kind
// of communication; Upcoming (dated work later than today, by day); Done.
// Rows share the Tasks-page row styling so a call looks the same wherever
// it appears. All actions are callbacks — the page owns the data.
import KindIcon from "@/components/dashboard/tasks/KindIcon";
import {
  KIND_ICON,
  KIND_LABEL,
  KIND_TONE,
  SECTION_ORDER,
  SECTION_TITLE,
  SECTION_WHY,
  isTask,
  reasonLabel,
  type InboxData,
  type InboxDone,
  type InboxItem,
  type InboxScope,
} from "@/components/dashboard/inbox/types";

export type Seg = "today" | "up" | "done";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "?";
const authorName = (email: string) => {
  const local = email.split("@")[0] || "Teammate";
  return local.charAt(0).toUpperCase() + local.slice(1);
};
// Date-only strings are calendar days (noon local avoids a UTC slip);
// instants are converted to the viewer's zone.
const fmtDay = (iso: string) => {
  const d = iso.length === 10 ? new Date(iso + "T12:00:00") : new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
};
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
};
const fmtWhen = (item: InboxItem, today: string) => {
  if (item.dueDate) {
    const t = item.dueTime ? ` · ${item.dueTime}` : "";
    if (item.overdue) return `Overdue · ${fmtDay(item.dueDate)}${t}`;
    if (item.dueDate === today) return `Today${t}`;
    return `${fmtDay(item.dueDate)}${t}`;
  }
  const d = new Date(item.at);
  if (d.toLocaleDateString("en-CA") === today) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toLocaleDateString("en-CA") === addDays(today, -1)) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
const rowAction = (item: InboxItem) => {
  if (item.kind === "mail") return "Reply";
  if (item.kind === "temail") return item.detail.startsWith("reply") ? "Reply" : "Write";
  if (item.kind === "app" || item.kind === "drop" || item.kind === "ref") return "Review";
  if (item.kind === "tcall") return "Call";
  if (item.kind === "tmsg") return "Message";
  return "Open";
};

export default function InboxView({
  data,
  scope,
  seg,
  viewer,
  currentId,
  busyIds,
  onScope,
  onSeg,
  onOpen,
  onTick,
  onReopen,
  onEdit,
}: {
  data: InboxData | null;
  scope: InboxScope;
  seg: Seg;
  viewer: string;
  currentId: string | null;
  busyIds: Set<string>;
  onScope: (s: InboxScope) => void;
  onSeg: (s: Seg) => void;
  onOpen: (item: InboxItem) => void;
  onTick: (item: InboxItem) => void;
  onReopen: (d: InboxDone) => void;
  onEdit: (item: InboxItem) => void;
}) {
  const c = data?.counts;
  const today = data?.today || new Date().toLocaleDateString("en-CA");

  const row = (item: InboxItem, opts: { upcoming?: boolean } = {}) => {
    const tone = KIND_TONE[item.kind];
    const openable = Boolean(item.candidateKey);
    const forChip = scope === "team" && item.forEmail && item.forEmail !== viewer ? `for ${authorName(item.forEmail)}` : null;
    return (
      <div
        key={item.id}
        className={`tk-row ib-row${item.seen ? " seen" : ""}${openable ? " tk-click" : ""}${currentId === item.id ? " cur" : ""}`}
        role={openable ? "button" : undefined}
        onClick={() => openable && onOpen(item)}
      >
        {opts.upcoming ? (
          <span className="tk-tick ib-tick-ghost" aria-hidden="true" />
        ) : (
          <button
            type="button"
            className="tk-tick"
            title={item.kind === "fdue" ? "Mark contacted" : isTask(item.kind) ? "Mark done" : "Done"}
            aria-label="Done"
            disabled={busyIds.has(item.id)}
            onClick={(e) => {
              e.stopPropagation();
              onTick(item);
            }}
          />
        )}
        <span className={`ib-kind ${tone}`}>
          <KindIcon kind={KIND_ICON[item.kind]} className="tk-ico" />
        </span>
        <span className="ib-what">
          <span className="t">
            <i className="ib-dot" aria-hidden="true" />
            {item.title}
            {item.extra && <span className="ib-lbl box">{item.extra}</span>}
            {item.also && item.also.length > 0 && (
              <span className="ib-also">
                {item.also.map((x) => (
                  <span key={x.id} className={`ib-lbl ${KIND_TONE[x.kind]}`} title={x.title}>
                    {KIND_LABEL[x.kind]}
                  </span>
                ))}
              </span>
            )}
          </span>
          {item.detail && <span className="d">{item.detail}</span>}
        </span>
        <span className={`ib-lbl ${tone}`}>{KIND_LABEL[item.kind]}</span>
        {forChip && <span className="ib-lbl box">{forChip}</span>}
        {item.candidateKey && (
          <span className="tk-cand ib-cand">
            <span className="av">{initials(item.candidateName)}</span>
            {item.candidateName}
          </span>
        )}
        <span className={`tk-due${item.overdue ? " bad" : ""}`}>{fmtWhen(item, today)}</span>
        {isTask(item.kind) || item.kind === "fdue" ? (
          <button
            type="button"
            className="tk-doneb tk-editb"
            title={item.kind === "fdue" ? "Move their follow-up date" : "Edit, reschedule, or delete"}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(item);
            }}
          >
            Edit
          </button>
        ) : null}
        {openable ? (
          <button
            type="button"
            className="tk-doneb ib-go"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(item);
            }}
          >
            {rowAction(item)} ›
          </button>
        ) : (
          !opts.upcoming && (
            <button
              type="button"
              className="tk-doneb"
              disabled={busyIds.has(item.id)}
              onClick={(e) => {
                e.stopPropagation();
                onTick(item);
              }}
            >
              {busyIds.has(item.id) ? "…" : "Done"}
            </button>
          )
        )}
      </div>
    );
  };

  return (
    <>
      <div className="tk-head">
        <div>
          <h1 className="dash-h1">Inbox</h1>
          <p className="dash-sub">
            {c
              ? c.today
                ? `${c.today} to do today${c.overdue ? ` · ${c.overdue} overdue` : ""}`
                : "Nothing left for today."
              : "Every communication you owe today, in one place."}
          </p>
        </div>
        <div className="ib-headright">
          <span className="dash-tabs tk-seg ib-scope" role="group" aria-label="Whose inbox">
            <button className={scope === "me" ? "on" : ""} onClick={() => onScope("me")}>
              Me
            </button>
            <button className={scope === "team" ? "on" : ""} onClick={() => onScope("team")}>
              Team
            </button>
          </span>
          <span className="dash-tabs tk-seg">
            {(
              [
                ["today", "Today", c?.today ?? null],
                ["up", "Upcoming", c?.upcoming ?? null],
                ["done", "Done", c?.done ?? null],
              ] as [Seg, string, number | null][]
            ).map(([v, label, n]) => (
              <button key={v} className={seg === v ? "on" : ""} onClick={() => onSeg(v)}>
                {label}
                {n !== null && <span className="n">{n}</span>}
              </button>
            ))}
          </span>
        </div>
      </div>

      {!data && <p className="dash-muted">Loading…</p>}

      {data && seg === "today" && (
        <>
          {data.items.length === 0 && (
            <div className="ib-clear">
              <b>Inbox clear</b>
              {scope === "me"
                ? "Nothing waiting on you today. Replies and new people appear here as they arrive; dated work moves in from Upcoming on its day."
                : "Nothing waiting on the team today."}
            </div>
          )}
          {SECTION_ORDER.map((s) => {
            const g = data.items.filter((i) => i.section === s);
            if (!g.length) return null;
            const od = g.filter((i) => i.overdue).length;
            return (
              <div className="tk-day" key={s}>
                <div className="tk-day-h ib-sec-h">
                  {SECTION_TITLE[s]} <span className="cnt">· {g.length}</span>
                  {od > 0 && <span className="ib-od">{od} overdue</span>}
                  {SECTION_WHY[s] && <span className="ib-why">{SECTION_WHY[s]}</span>}
                </div>
                <div className="tk-rows">{g.map((it) => row(it))}</div>
              </div>
            );
          })}
        </>
      )}

      {data && seg === "up" && (
        <>
          {data.upcoming.length === 0 && (
            <p className="tk-empty">Nothing dated later than today. Tasks are created from a candidate&apos;s drawer.</p>
          )}
          {data.upcoming.map((d) => (
            <div className="tk-day" key={d.day}>
              <div className="tk-day-h">
                {d.day === addDays(today, 1) ? `Tomorrow · ${fmtDay(d.day)}` : fmtDay(d.day)}{" "}
                <span className="cnt">· {d.items.length}</span>
              </div>
              <div className="tk-rows">{d.items.map((it) => row(it, { upcoming: true }))}</div>
            </div>
          ))}
        </>
      )}

      {data && seg === "done" && (
        <div className="tk-day">
          <div className="tk-day-h">
            Handled this week <span className="cnt">· {data.done.length}</span>
          </div>
          {data.done.length === 0 ? (
            <p className="tk-empty">Nothing handled yet this week.</p>
          ) : (
            <div className="tk-rows">
              {data.done.map((d) => {
                const kind = d.kind === "task" ? "ttask" : d.kind;
                const tone = KIND_TONE[kind];
                // Only a plain Done (or a completed task) can come back; a stage
                // move, a sent email or a reply is history, not a mark.
                const canReopen = d.kind === "task" || d.reason === "done";
                return (
                  <div className="tk-row ib-row seen done" key={d.id}>
                    <span className="tk-tick done" aria-hidden="true" />
                    <span className={`ib-kind ${tone}`}>
                      <KindIcon kind={KIND_ICON[kind]} className="tk-ico" />
                    </span>
                    <span className="ib-what">
                      <span className="t">{d.title || KIND_LABEL[kind]}</span>
                      <span className="d">{reasonLabel(d.reason, d.kind)}</span>
                    </span>
                    <span className={`ib-lbl ${tone}`}>{d.kind === "task" ? "Task" : KIND_LABEL[kind]}</span>
                    {d.candidateName && (
                      <span className="tk-cand ib-cand">
                        <span className="av">{initials(d.candidateName)}</span>
                        {d.candidateName}
                      </span>
                    )}
                    <span className="tk-due">{d.at ? fmtDay(d.at) : ""}</span>
                    {canReopen && (
                      <button type="button" className="tk-doneb" disabled={busyIds.has(d.id)} onClick={() => onReopen(d)}>
                        Reopen
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}
