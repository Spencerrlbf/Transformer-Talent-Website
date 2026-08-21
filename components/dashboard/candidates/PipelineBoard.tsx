"use client";
// Pipeline board: the Kanban view of a job's pipeline. Same data and same
// status writes as the table — a drag is the table's stage dropdown in
// another shape. Columns: fixed stages, with "interviewing" expanded into
// the job's configurable interview stages (blue).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import StageEditor, { type StageDef } from "@/components/dashboard/jobs/StageEditor";
import type { Cv2Row } from "@/components/dashboard/candidates/CandidatesTable";

const TAG_CLASS: Record<string, string> = {
  strong_yes: "t-strong",
  strong: "t-strong",
  yes: "t-yes",
  possible: "t-possible",
  worth_message: "t-msg",
  stretch: "t-stretch",
  not_now: "t-notnow",
};

type Column = {
  key: string;
  label: string;
  status: string;
  interviewStage: string | null;
  iv: boolean;
  ivIndex?: number;
  ivTotal?: number;
};

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

function daysIn(row: Cv2Row): string {
  const since = row.stageUpdatedAt || row.addedAt;
  if (!since) return "";
  const d = Math.floor((Date.now() - new Date(since).getTime()) / 86400000);
  return d < 1 ? "<1d" : `${d}d`;
}

export default function PipelineBoard({
  jobId,
  refreshKey,
  onOpen,
  onChanged,
}: {
  jobId: string;
  refreshKey: number;
  onOpen: (key: string) => void;
  /** Called after any successful stage write so the table + counts refetch. */
  onChanged: () => void;
}) {
  const { token } = useDash();
  const [rows, setRows] = useState<Cv2Row[] | null>(null);
  const [stages, setStages] = useState<StageDef[]>([]);
  const [custom, setCustom] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const dragRow = useRef<Cv2Row | null>(null);

  const load = useCallback(async () => {
    try {
      const all: Cv2Row[] = [];
      for (let page = 1; page <= 2; page++) {
        const params = new URLSearchParams({
          job: jobId,
          hideNotNow: "1",
          sort: "fit",
          page: String(page),
          pageSize: "100",
        });
        const res = await fetch(`/api/dashboard/candidates/v2?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { items: Cv2Row[]; total: number };
        all.push(...json.items);
        if (all.length >= json.total) break;
      }
      setRows(all);
    } catch {
      setError("Couldn't load the board — refresh to retry.");
    }
  }, [jobId, token]);

  const loadStages = useCallback(() => {
    fetch(`/api/dashboard/jobs/${jobId}/stages`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.stages) {
          setStages(d.stages);
          setCustom(!!d.custom);
        }
      })
      .catch(() => {});
  }, [jobId, token]);

  useEffect(() => {
    load();
    loadStages();
  }, [load, loadStages, refreshKey]);

  const columns = useMemo<Column[]>(() => {
    const fixedBefore: Column[] = [
      { key: "new", label: "New", status: "new", interviewStage: null, iv: false },
      { key: "contacted", label: "Contacted", status: "contacted", interviewStage: null, iv: false },
      { key: "replied", label: "Replied", status: "replied", interviewStage: null, iv: false },
    ];
    const iv: Column[] = stages.map((s, i) => ({
      key: `iv_${s.id}`,
      label: s.label,
      status: "interviewing",
      interviewStage: s.id,
      iv: true,
      ivIndex: i + 1,
      ivTotal: stages.length,
    }));
    const fixedAfter: Column[] = [
      { key: "offer", label: "Offer", status: "offer", interviewStage: null, iv: false },
      { key: "hired", label: "Hired", status: "hired", interviewStage: null, iv: false },
    ];
    return [...fixedBefore, ...iv, ...fixedAfter];
  }, [stages]);

  const colOf = useCallback(
    (r: Cv2Row): string => {
      const stage = r.stage || "new";
      if (stage !== "interviewing") return stage;
      const known = stages.find((s) => s.id === r.interviewStage);
      return `iv_${(known ?? stages[0])?.id ?? ""}`;
    },
    [stages]
  );

  async function moveTo(row: Cv2Row, col: Column) {
    if (colOf(row) === col.key) return;
    setError("");
    const prev = { stage: row.stage, interviewStage: row.interviewStage, stageUpdatedAt: row.stageUpdatedAt };
    const nextRow = {
      ...row,
      stage: col.status,
      interviewStage: col.interviewStage,
      stageUpdatedAt: new Date().toISOString(),
    };
    setRows((rs) => (rs ? rs.map((r) => (r.key === row.key ? nextRow : r)) : rs));
    try {
      const res = await fetch(`/api/dashboard/candidates/v2/${row.key}/status`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          status: col.status,
          interviewStage: col.interviewStage,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      onChanged();
    } catch {
      setRows((rs) => (rs ? rs.map((r) => (r.key === row.key ? { ...r, ...prev } : r)) : rs));
      setError("Couldn't move that candidate — please try again.");
    }
  }

  async function reject(row: Cv2Row) {
    setError("");
    const before = rows;
    setRows((rs) => (rs ? rs.filter((r) => r.key !== row.key) : rs));
    try {
      const res = await fetch(`/api/dashboard/candidates/v2/${row.key}/status`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, status: "rejected" }),
      });
      if (!res.ok) throw new Error(String(res.status));
      onChanged();
    } catch {
      setRows(before ?? null);
      setError("Couldn't reject that candidate — please try again.");
    }
  }

  async function saveStages(body: { stages: StageDef[] | null }) {
    setEditorSaving(true);
    setEditorError("");
    try {
      const res = await fetch(`/api/dashboard/jobs/${jobId}/stages`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.stages) {
        setStages(json.stages);
        setCustom(!!json.custom);
        setEditing(false);
        load(); // template edits can remap candidates
      } else {
        setEditorError("Couldn't save — please try again.");
      }
    } catch {
      setEditorError("Couldn't save — please try again.");
    }
    setEditorSaving(false);
  }

  if (!rows) return <p className="dash-muted">Loading board…</p>;

  const byCol = new Map<string, Cv2Row[]>();
  for (const r of rows) {
    const k = colOf(r);
    byCol.set(k, [...(byCol.get(k) || []), r]);
  }

  return (
    <div>
      <div className="pb-bar">
        <span className="pb-count">{rows.length} in pipeline</span>
        <button className="stg-editbtn pb-edit" onClick={() => setEditing(true)}>
          Edit stages ⚙
        </button>
      </div>
      {error && <p className="dash-error">{error}</p>}
      <div className="pb-wrap">
        <div className="pb-board">
          {columns.map((col) => {
            const items = byCol.get(col.key) || [];
            return (
              <div
                key={col.key}
                className={`pb-col${col.iv ? " iv" : ""}${overCol === col.key ? " over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverCol(col.key);
                }}
                onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOverCol(null);
                  if (dragRow.current) moveTo(dragRow.current, col);
                }}
              >
                {col.iv && (
                  <div className="pb-ivgroup">
                    INTERVIEWING · {col.ivIndex}/{col.ivTotal}
                  </div>
                )}
                <div className="pb-colhead">
                  <b>{col.label}</b>
                  <span>{items.length}</span>
                </div>
                <div className="pb-cards">
                  {items.map((r) => (
                    <div
                      key={r.key}
                      className={`pb-card${dragKey === r.key ? " dragging" : ""}`}
                      draggable
                      onDragStart={(e) => {
                        dragRow.current = r;
                        setDragKey(r.key);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDragKey(null);
                        setOverCol(null);
                        dragRow.current = null;
                      }}
                      onClick={() => onOpen(r.key)}
                    >
                      <div className="pb-nm">
                        <span className="pb-av">{initials(r.name || "?")}</span>
                        {r.name}
                      </div>
                      <div className="pb-tt">
                        {[r.currentTitle, r.currentCompany].filter(Boolean).join(" @ ") || "—"}
                      </div>
                      <div className="pb-ft">
                        {r.bestTag ? (
                          <span className={`dash-tag ${TAG_CLASS[r.bestTag] || "t-pending"}`}>
                            {r.bestTagLabel}
                          </span>
                        ) : (
                          <span className="dash-tag t-pending">
                            {r.screeningPending === false ? "Not screened" : "Screening…"}
                          </span>
                        )}
                        <span className="pb-days">{daysIn(r)}</span>
                      </div>
                    </div>
                  ))}
                  {items.length === 0 && <div className="pb-empty">No one here yet</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {dragKey && (
        <div
          className="pb-reject"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (dragRow.current) reject(dragRow.current);
          }}
        >
          Drop here to reject → moves to the Past tab (restorable)
        </div>
      )}
      {editing && (
        <StageEditor
          title="Interview stages · this job"
          intro="The steps between Replied and Offer, in order. Drag to reorder, rename freely."
          initial={stages}
          showReset={custom}
          saving={editorSaving}
          error={editorError}
          onSave={(s) => saveStages({ stages: s })}
          onReset={() => saveStages({ stages: null })}
          onClose={() => {
            setEditing(false);
            setEditorError("");
          }}
        />
      )}
    </div>
  );
}
