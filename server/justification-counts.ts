import type { Deliveries, TaskJustification } from "../shared/types.js";

/** Keeps justified tasks reviewable while removing them from accountability counts. */
export function applyJustifications(
  data: Omit<Deliveries, "justified">,
  justifications: TaskJustification[],
): Deliveries {
  const byIssue = new Map(
    justifications.map((record) => [record.issueId, record]),
  );
  const issues: Deliveries["issues"] = [];
  const justified: Deliveries["justified"] = [];
  const students = data.students.map((student) => ({
    ...student,
    counts: { one: 0, twoThree: 0, fourFive: 0, overFive: 0 },
  }));
  const byStudent = new Map(students.map((student) => [student.id, student]));
  for (const issue of data.issues) {
    const justification = byIssue.get(issue.id);
    if (justification) {
      justified.push({ ...issue, justification });
      continue;
    }
    issues.push(issue);
    const student = byStudent.get(issue.studentId);
    if (student && Object.hasOwn(student.counts, issue.bucket))
      student.counts[issue.bucket as keyof typeof student.counts] += 1;
  }
  return { students, issues, justified, incomplete: data.incomplete };
}
