import type {
  Attendance,
  Deliveries,
  Sprint,
  TaskJustification,
} from "../shared/types.js";
export const demoSprints: Sprint[] = [
  {
    id: "demo-2",
    name: "Sprint 2",
    startsAt: "2026-09-18T03:00:00Z",
    endsAt: "2026-10-15T03:00:00Z",
  },
  {
    id: "demo-1",
    name: "Sprint 1",
    startsAt: "2026-09-03T03:00:00Z",
    endsAt: "2026-09-18T03:00:00Z",
  },
];
const names = ["Lara", "Fer", "Majo"];
export function demoDeliveries(sprintId: string): Deliveries {
  const values =
    sprintId === "demo-2"
      ? [
          [2, 3, 1, 0],
          [1, 2, 2, 1],
          [3, 1, 0, 1],
        ]
      : [
          [1, 1, 0, 1],
          [2, 0, 1, 0],
          [1, 2, 1, 0],
        ];
  const issues: Deliveries["issues"] = [];
  const keys = ["one", "twoThree", "fourFive", "overFive"] as const;
  const students = names.map((name, i) => {
    const counts = {
      one: values[i][0],
      twoThree: values[i][1],
      fourFive: values[i][2],
      overFive: values[i][3],
    };
    keys.forEach((bucket, k) => {
      for (let j = 0; j < values[i][k]; j++)
        issues.push({
          id: `00000000-0000-4000-8000-${String(issues.length + 1).padStart(12, "0")}`,
          identifier: `DEMO-${issues.length + 1}`,
          title: "Illustrative task — demo data",
          url: "https://linear.app",
          studentId: `demo-${i}`,
          studentName: name,
          deliveredAt: `2026-09-${[24, 25, 27, 30][k]}T18:00:00Z`,
          status: "Done",
          pending: false,
          dueDate: "2026-09-23",
          daysLate: [1, 2, 4, 7][k],
          bucket,
        });
    });
    return { id: `demo-${i}`, name, counts };
  });
  return { students, issues, incomplete: [], justified: [] };
}
export const demoJustifications = new Map<string, TaskJustification>();
const stores = new Map<string, Attendance>();
export function demoAttendance(sprintId: string) {
  if (!stores.has(sprintId))
    stores.set(sprintId, {
      students: names.map((name, i) => ({ id: `demo-${i}`, name })),
      sessions: [],
      records: [],
    });
  return stores.get(sprintId)!;
}
export function demoSave(input: import("./attendance.js").SaveAttendanceInput) {
  const store = demoAttendance(input.sprintId);
  let session = store.sessions.find(
    (s) => s.date === input.sessionDate && s.type === input.sessionType,
  );
  if (!session) {
    session = {
      id: crypto.randomUUID(),
      date: input.sessionDate,
      type: input.sessionType,
      sprintId: input.sprintId,
    };
    store.sessions.push(session);
  }
  const old = store.records.find(
    (r) => r.sessionId === session.id && r.studentId === input.studentId,
  );
  const record = {
    id: old?.id ?? crypto.randomUUID(),
    studentId: input.studentId,
    sessionId: session.id,
    category: input.category,
    noticeAt: input.noticeAt || null,
    justification: input.justification || null,
    updateText: input.updateText || null,
  };
  if (old) Object.assign(old, record);
  else store.records.push(record);
  return record;
}
export function demoDelete(id: string) {
  for (const store of stores.values())
    store.records = store.records.filter((r) => r.id !== id);
}
