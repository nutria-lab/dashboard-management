export type Sprint = {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
};
export type Student = { id: string; name: string };
export type Counts = {
  one: number;
  twoThree: number;
  fourFive: number;
  overFive: number;
};
export type Delivery = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  studentId: string;
  studentName: string;
  deliveredAt: string;
  dueDate: string;
  daysLate: number;
  bucket: string;
};
export type Deliveries = {
  students: (Student & { counts: Counts })[];
  issues: Delivery[];
  incomplete: { identifier: string; reason: string }[];
};
export const categories = {
  PRESENT: "Present",
  REMOTE_JUSTIFIED: "Remote · justified",
  REMOTE_UNJUSTIFIED: "Remote · unjustified",
  ABSENT_JUSTIFIED: "Absent · justified",
  ABSENT_UNJUSTIFIED: "Absent · unjustified",
} as const;
export type Category = keyof typeof categories;
export const sessionTypes = {
  REGULAR: "Regular",
  PLANNING: "Planning",
  REVIEW: "Review",
  STEERING: "Steering",
} as const;
export type SessionType = keyof typeof sessionTypes;
export type ClassSession = {
  id: string;
  date: string;
  type: SessionType;
  sprintId: string;
};
export type AttendanceRecord = {
  id: string;
  studentId: string;
  sessionId: string;
  category: Category;
  noticeAt: string | null;
  justification: string | null;
  updateText: string | null;
};
export type Attendance = {
  sessions: ClassSession[];
  records: AttendanceRecord[];
  students: Student[];
};
export type AttendanceInput = {
  studentId: string;
  studentName: string;
  sprintId: string;
  sprintName: string;
  sessionDate: string;
  sessionType: SessionType;
  category: Category;
  noticeAt?: string;
  justification?: string;
  updateText?: string;
};
