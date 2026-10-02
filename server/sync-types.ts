export type LinearTaskData = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  teamId: string;
  sprintId: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  stateId: string;
  stateName: string;
  stateType: string;
  dueDate: string | null;
  updatedAt: string;
  completedAt: string | null;
};
export type LinearMetadata = {
  sprints: { id: string; name: string; startsAt: string; endsAt: string }[];
  students: { id: string; name: string }[];
  openStateIds: string[];
};
export type LinearPage = { tasks: LinearTaskData[]; nextCursor: string | null };
