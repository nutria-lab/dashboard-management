import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { categories, sessionTypes } from "../shared/types";
import type {
  Attendance,
  AttendanceInput,
  AttendanceRecord,
  Category,
  Deliveries,
  SessionType,
  Sprint,
  Student,
} from "../shared/types";
import "./App.css";
const DeliveryChart = lazy(() => import("./DeliveryChart"));
const series = [
  { key: "one", label: "1 day", color: "#708e67" },
  { key: "twoThree", label: "2–3 days", color: "#f1c66d" },
  { key: "fourFive", label: "4–5 days", color: "#e88669" },
  { key: "overFive", label: ">5 days", color: "#a4543d" },
] as const;
const blankAttendance: Attendance = { students: [], sessions: [], records: [] };
const localDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
function AttendanceForm({
  students,
  sprint,
  attendance,
  record,
  onClose,
  onSave,
}: {
  students: Student[];
  sprint: Sprint;
  attendance: Attendance;
  record?: AttendanceRecord;
  onClose: () => void;
  onSave: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const session = attendance.sessions.find((s) => s.id === record?.sessionId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sessionType, setSessionType] = useState<SessionType>(
    session?.type ?? "REGULAR",
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const values = Object.fromEntries(
      new FormData(event.currentTarget),
    ) as Record<string, string>;
    const student = students.find((s) => s.id === values.studentId);
    if (!student) {
      setError("Select a student.");
      setSaving(false);
      return;
    }
    const input: AttendanceInput = {
      studentId: student.id,
      studentName: student.name,
      sprintId: sprint.id,
      sprintName: sprint.name,
      sessionDate: values.sessionDate,
      sessionType,
      category: values.category as Category,
      justification: values.justification || undefined,
      updateText: values.updateText || undefined,
      noticeAt: values.noticeAt
        ? new Date(values.noticeAt).toISOString()
        : undefined,
    };
    try {
      await api("/attendance", { method: "POST", body: JSON.stringify(input) });
      onSave();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog ref={dialog} onCancel={onClose} aria-labelledby="attendance-title">
      <form onSubmit={submit}>
        <div className="dialog-heading">
          <h2 id="attendance-title">
            {record ? "Edit attendance" : "Record attendance"}
          </h2>
          <button type="button" className="quiet" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted">
          {sprint.name} · one record per student and class
        </p>
        <div className="form-grid">
          <label>
            Student
            <select
              name="studentId"
              defaultValue={record?.studentId ?? students[0]?.id}
              required
              disabled={!!record}
            >
              {students.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {record && (
            <input type="hidden" name="studentId" value={record.studentId} />
          )}
          <label>
            Class date
            <input
              name="sessionDate"
              type="date"
              defaultValue={session?.date.slice(0, 10) ?? localDate()}
              required
              readOnly={!!record}
            />
          </label>
          <label>
            Class type
            <select
              name="sessionType"
              value={sessionType}
              disabled={!!record}
              onChange={(e) => setSessionType(e.target.value as SessionType)}
            >
              {Object.entries(sessionTypes).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Attendance
            <select
              name="category"
              defaultValue={record?.category ?? "PRESENT"}
            >
              {Object.entries(categories).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {sessionType !== "REGULAR" && (
          <p className="notice">
            {sessionTypes[sessionType]} requires in-person attendance.
            Exceptions remain visible in the register.
          </p>
        )}
        <label>
          Notice sent at (optional)
          <input
            name="noticeAt"
            type="datetime-local"
            defaultValue={
              record?.noticeAt
                ? new Date(
                    new Date(record.noticeAt).getTime() -
                      new Date(record.noticeAt).getTimezoneOffset() * 60000,
                  )
                    .toISOString()
                    .slice(0, 16)
                : ""
            }
          />
        </label>
        <label>
          Justification (optional)
          <textarea
            name="justification"
            maxLength={2000}
            defaultValue={record?.justification ?? ""}
          />
        </label>
        <label>
          Update sent before class (optional)
          <textarea
            name="updateText"
            maxLength={2000}
            defaultValue={record?.updateText ?? ""}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button disabled={saving}>
            {saving ? "Saving…" : "Save attendance"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function App() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [sprintId, setSprintId] = useState("");
  const [tab, setTab] = useState<"deliveries" | "attendance">("deliveries");
  const [deliveries, setDeliveries] = useState<Deliveries | null>(null);
  const [deliveryError, setDeliveryError] = useState("");
  const [attendance, setAttendance] = useState<Attendance>(blankAttendance);
  const [attendanceError, setAttendanceError] = useState("");
  const [today] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [form, setForm] = useState<{ record?: AttendanceRecord } | null>(null);
  const [detail, setDetail] = useState<{
    studentId: string;
    bucket?: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  useEffect(() => {
    const c = new AbortController();
    api<{ authenticated: boolean; demo: boolean }>("/session", {
      signal: c.signal,
    })
      .then((s) => {
        setAuth(s.authenticated);
        setDemo(s.demo);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          setAuth(false);
          setError(e.message);
        }
      });
    return () => c.abort();
  }, []);
  useEffect(() => {
    if (!auth) return;
    const c = new AbortController();
    api<Sprint[]>("/sprints", { signal: c.signal })
      .then((list) => {
        setSprints(list);
        resetSprintData();
        const now = Date.now();
        setSprintId(
          list.find(
            (s) => Date.parse(s.startsAt) <= now && Date.parse(s.endsAt) > now,
          )?.id ??
            list[0]?.id ??
            "",
        );
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [auth]);
  useEffect(() => {
    if (!auth || !sprintId) return;
    const c = new AbortController();
    const query = "?sprintId=" + encodeURIComponent(sprintId);
    const tasks = [
      api<Deliveries>("/deliveries" + query, { signal: c.signal })
        .then(setDeliveries)
        .catch((e) => {
          if (!c.signal.aborted) setDeliveryError(e.message);
        }),
      api<Attendance>("/attendance" + query, { signal: c.signal })
        .then(setAttendance)
        .catch((e) => {
          if (!c.signal.aborted) setAttendanceError(e.message);
        }),
    ];
    Promise.all(tasks).then(() => {
      if (!c.signal.aborted) setLoading(false);
    });
    return () => c.abort();
  }, [auth, sprintId, reload]);
  function resetSprintData() {
    setLoading(true);
    setDeliveries(null);
    setAttendance(blankAttendance);
    setDeliveryError("");
    setAttendanceError("");
    setDetail(null);
  }
  function refresh() {
    resetSprintData();
    setReload((n) => n + 1);
  }
  async function login(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/session", {
        method: "POST",
        body: JSON.stringify({
          password: new FormData(e.currentTarget).get("password"),
        }),
      });
      setAuth(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await api("/session", { method: "DELETE" });
      setAuth(false);
      setSprints([]);
      setSprintId("");
      setDeliveries(null);
      setAttendance(blankAttendance);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function removeRecord(id: string) {
    setError("");
    try {
      await api("/attendance?id=" + encodeURIComponent(id), {
        method: "DELETE",
      });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(null);
    }
  }
  const sprint = sprints.find((s) => s.id === sprintId);
  const students = [
    ...new Map(
      [...attendance.students, ...(deliveries?.students ?? [])].map((s) => [
        s.id,
        { id: s.id, name: s.name },
      ]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const rows =
    deliveries?.students.map((s) => ({
      id: s.id,
      name: s.name,
      ...s.counts,
    })) ?? [];
  const detailed =
    deliveries?.issues.filter(
      (i) =>
        i.studentId === detail?.studentId &&
        (!detail.bucket || i.bucket === detail.bucket),
    ) ?? [];
  return (
    <>
      <header>
        <div className="brand">
          <span>Lab II</span>
          <i />
          <span className="brand-product">NutrIA</span>
        </div>
        <nav aria-label="Main">
          {auth && (
            <>
              <button
                className={tab === "deliveries" ? "active" : ""}
                onClick={() => setTab("deliveries")}
              >
                Deliveries
              </button>
              <button
                className={tab === "attendance" ? "active" : ""}
                onClick={() => setTab("attendance")}
              >
                Attendance
              </button>
            </>
          )}
        </nav>
        <div className="header-right">
          <time>
            {new Intl.DateTimeFormat("en-US", {
              timeZone: "America/Argentina/Buenos_Aires",
              month: "long",
              day: "numeric",
              year: "numeric",
            }).format(today)}
          </time>
          {auth && (
            <button className="quiet" onClick={logout}>
              Sign out
            </button>
          )}
        </div>
      </header>
      {auth === null ? (
        <main>
          <p role="status">Loading…</p>
        </main>
      ) : !auth ? (
        <main className="login">
          <h1>Welcome back</h1>
          <p>Sign in to review deliveries and attendance.</p>
          <form onSubmit={login}>
            <label>
              Teacher password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </main>
      ) : (
        <main>
          <div className="page-heading">
            <div>
              <h1>{tab === "deliveries" ? "Late deliveries" : "Attendance"}</h1>
              <p>
                {tab === "deliveries"
                  ? "Review late delivered tasks by sprint and student."
                  : "Record class attendance and review participation by sprint."}
              </p>
            </div>
            <label className="sprint-label">
              <span className="sr-only">Sprint</span>
              <select
                value={sprintId}
                onChange={(e) => {
                  resetSprintData();
                  setSprintId(e.target.value);
                }}
              >
                {sprints.length ? (
                  sprints.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))
                ) : (
                  <option>No sprints available</option>
                )}
              </select>
            </label>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {loading && <p role="status">Loading sprint data…</p>}
          {tab === "deliveries" && (
            <section className="chart-section" aria-labelledby="chart-title">
              <div className="section-heading">
                <h2 id="chart-title">
                  Late tasks by student{" "}
                  {demo && (
                    <span
                      className="demo-badge"
                      title="Illustrative data; attendance resets on restart"
                    >
                      Demo data
                    </span>
                  )}
                </h2>
                <p className="mobile-only">
                  Swipe the chart to see all students.
                </p>
                <ul className="legend">
                  {series.map((s) => (
                    <li key={s.key}>
                      <span style={{ background: s.color }} />
                      {s.label}
                    </li>
                  ))}
                </ul>
              </div>
              {deliveryError ? (
                <div className="empty">
                  <p role="alert">{deliveryError}</p>
                  <button className="quiet" onClick={refresh}>
                    Try again
                  </button>
                </div>
              ) : !loading && rows.length === 0 ? (
                <p className="empty">
                  No students or deliveries found for this sprint.
                </p>
              ) : (
                <div className="chart-scroll">
                  <div
                    className="chart"
                    style={{ minWidth: Math.max(550, rows.length * 160) }}
                  >
                    <Suspense fallback={<p role="status">Loading chart…</p>}>
                      <DeliveryChart
                        rows={rows}
                        series={series}
                        onDetail={setDetail}
                      />
                    </Suspense>
                  </div>
                </div>
              )}
              <p className="chart-caption">
                First entry to In Review · calendar days in Buenos Aires · click
                a bar or select a student below.
              </p>
              <details>
                <summary>View counts and task details</summary>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Student</th>
                        {series.map((s) => (
                          <th key={s.key}>{s.label}</th>
                        ))}
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <th>
                            <button
                              className="text-button"
                              onClick={() => setDetail({ studentId: r.id })}
                            >
                              {r.name}
                            </button>
                          </th>
                          {series.map((s) => (
                            <td key={s.key}>{r[s.key]}</td>
                          ))}
                          <td>
                            {r.one + r.twoThree + r.fourFive + r.overFive}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
              {detail && (
                <div className="task-details">
                  <div className="section-heading">
                    <h3>
                      {rows.find((r) => r.id === detail.studentId)?.name} ·
                      delivery details
                    </h3>
                    <button className="quiet" onClick={() => setDetail(null)}>
                      Close details
                    </button>
                  </div>
                  {detailed.length ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Task</th>
                            <th>Due date</th>
                            <th>Delivered</th>
                            <th>Days late</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailed.map((i) => (
                            <tr key={i.id}>
                              <td>
                                <a
                                  href={i.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {i.identifier}
                                </a>{" "}
                                {i.title}
                              </td>
                              <td>{i.dueDate}</td>
                              <td>
                                {new Intl.DateTimeFormat("en-CA", {
                                  timeZone: "America/Argentina/Buenos_Aires",
                                }).format(new Date(i.deliveredAt))}
                              </td>
                              <td>{i.daysLate}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p>No late deliveries in this group.</p>
                  )}
                </div>
              )}
              {!!deliveries?.incomplete.length && (
                <details className="incomplete">
                  <summary>
                    {deliveries.incomplete.length} tasks with incomplete data
                  </summary>
                  <ul>
                    {deliveries.incomplete.map((i) => (
                      <li key={i.identifier}>
                        {i.identifier}: {i.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
          <section
            className="attendance-section"
            aria-labelledby="attendance-heading"
          >
            <div className="section-heading">
              <div>
                <h2 id="attendance-heading">
                  Attendance{" "}
                  {demo && (
                    <span
                      className="demo-badge"
                      title="Illustrative data; attendance resets on restart"
                    >
                      Demo data
                    </span>
                  )}
                </h2>
                <p>Participation and absences, recorded per class.</p>
                <p className="mobile-only">
                  Swipe the table to see all categories.
                </p>
              </div>
              <button
                disabled={!sprint || !students.length || !!attendanceError}
                onClick={() => setForm({})}
              >
                Record attendance
              </button>
            </div>
            {attendanceError ? (
              <p role="alert" className="error">
                {attendanceError}
              </p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Student</th>
                      {Object.entries(categories).map(([key, label]) => (
                        <th key={key}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {students.map((s) => (
                      <tr key={s.id}>
                        <th>
                          <span className="initials" aria-hidden="true">
                            {s.name
                              .split(" ")
                              .map((n) => n[0])
                              .slice(0, 2)
                              .join("")}
                          </span>
                          {s.name}
                        </th>
                        {Object.keys(categories).map((key) => (
                          <td key={key}>
                            {
                              attendance.records.filter(
                                (r) =>
                                  r.studentId === s.id && r.category === key,
                              ).length
                            }
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!students.length && !loading && (
                  <p className="empty">
                    No students available yet. Configure Linear to load the
                    roster.
                  </p>
                )}
              </div>
            )}
            <p className="chart-caption">
              Planning, review and steering require in-person attendance.
              Categories are recorded separately; no grades are calculated.
            </p>
          </section>
          {tab === "attendance" && !attendanceError && (
            <section className="register">
              <h2>Class register</h2>
              {attendance.records.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Date / class</th>
                        <th>Student</th>
                        <th>Attendance</th>
                        <th>Notes</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attendance.records.map((r) => {
                        const session = attendance.sessions.find(
                          (s) => s.id === r.sessionId,
                        );
                        return (
                          <tr key={r.id}>
                            <td>
                              {session?.date.slice(0, 10)}
                              <small>
                                {session && sessionTypes[session.type]}
                                {session?.type !== "REGULAR" &&
                                r.category !== "PRESENT"
                                  ? " · presence required"
                                  : ""}
                              </small>
                            </td>
                            <td>
                              {students.find((s) => s.id === r.studentId)?.name}
                            </td>
                            <td>{categories[r.category]}</td>
                            <td>
                              {r.justification ?? "—"}
                              {r.updateText && <small>{r.updateText}</small>}
                              {r.noticeAt && (
                                <small>
                                  Notice:{" "}
                                  {new Date(r.noticeAt).toLocaleString("en-US")}
                                </small>
                              )}
                            </td>
                            <td className="actions">
                              <button
                                className="quiet"
                                onClick={() => setForm({ record: r })}
                              >
                                Edit
                              </button>
                              <button
                                className="quiet danger"
                                onClick={() => setDeleting(r.id)}
                              >
                                Delete
                              </button>
                              {deleting === r.id && (
                                <span>
                                  Delete this record?{" "}
                                  <button
                                    className="danger"
                                    onClick={() => removeRecord(r.id)}
                                  >
                                    Confirm
                                  </button>
                                  <button
                                    className="quiet"
                                    onClick={() => setDeleting(null)}
                                  >
                                    Cancel
                                  </button>
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="empty">
                  No attendance recorded for this sprint. Add the first class
                  record above.
                </p>
              )}
            </section>
          )}
          {form && sprint && (
            <AttendanceForm
              key={form.record?.id ?? "new"}
              students={students}
              sprint={sprint}
              attendance={attendance}
              record={form.record}
              onClose={() => setForm(null)}
              onSave={refresh}
            />
          )}
          <footer>
            {sprint?.name} · Lab II · Dates use Buenos Aires time
            {demo && (
              <small>
                Demo data is illustrative. Attendance changes reset when the
                server restarts.
              </small>
            )}
          </footer>
        </main>
      )}
    </>
  );
}
export default App;
