const BUENOS_AIRES_TIME_ZONE = "America/Argentina/Buenos_Aires";

export interface DeliveryCounts {
  one: number;
  twoThree: number;
  fourFive: number;
  overFive: number;
}

export interface DeliverySnapshot {
  deliveredAt: string;
  dueDate: string | null;
  assigneeId: string | null;
  cycleId: string | null;
}

export interface IssueHistoryEventLike {
  createdAt: Date | string;
  fromAssigneeId?: string | null;
  fromCycleId?: string | null;
  fromDueDate?: string | null;
  fromStateId?: string | null;
  toAssigneeId?: string | null;
  toCycleId?: string | null;
  toDueDate?: string | null;
  toStateId?: string | null;
}

export interface IssueValuesAtNow {
  assigneeId?: string | null;
  cycleId?: string | null;
  dueDate?: string | null;
}

export interface PagedConnection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean };
  fetchNext(): Promise<unknown>;
}

export function parseStudentAllowlist(
  value: string | undefined | null,
): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isStudentAllowed(
  id: string,
  allowlist: ReadonlySet<string>,
): boolean {
  return allowlist.size === 0 || allowlist.has(id.trim().toLowerCase());
}

export async function collectAllPages<T>(
  connection: PagedConnection<T>,
): Promise<T[]> {
  const nodes = [...connection.nodes];
  let previousLength = connection.nodes.length;

  while (connection.pageInfo.hasNextPage) {
    await connection.fetchNext();
    if (connection.nodes.length <= previousLength) {
      throw new Error(
        "Linear returned an empty page while more results were available.",
      );
    }
    nodes.push(...connection.nodes.slice(previousLength));
    previousLength = connection.nodes.length;
  }

  return nodes;
}

function timestamp(value: Date | string): number {
  const milliseconds =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("Linear returned an invalid history timestamp.");
  }
  return milliseconds;
}

function hasFieldChange(
  event: IssueHistoryEventLike,
  field: "AssigneeId" | "CycleId" | "DueDate",
): boolean {
  const from = event[`from${field}`];
  const to = event[`to${field}`];
  return (
    (from !== undefined && from !== null) || (to !== undefined && to !== null)
  );
}

/** Rewinds later issue edits to the values present on the first transition into Review. */
export function reconstructDeliverySnapshot(
  current: IssueValuesAtNow,
  history: readonly IssueHistoryEventLike[],
  reviewStateId: string,
): DeliverySnapshot | null {
  const chronologicalHistory = [...history].sort(
    (left, right) => timestamp(left.createdAt) - timestamp(right.createdAt),
  );
  const deliveryIndex = chronologicalHistory.findIndex(
    (event) =>
      event.toStateId === reviewStateId && event.fromStateId !== reviewStateId,
  );

  if (deliveryIndex < 0) return null;
  const deliveryEvent = chronologicalHistory[deliveryIndex];

  const deliveredAtMilliseconds = timestamp(deliveryEvent.createdAt);
  let dueDate = current.dueDate ?? null;
  let assigneeId = current.assigneeId ?? null;
  let cycleId = current.cycleId ?? null;

  for (let index = chronologicalHistory.length - 1; index >= 0; index -= 1) {
    if (index <= deliveryIndex) break;
    const event = chronologicalHistory[index];

    if (hasFieldChange(event, "DueDate")) dueDate = event.fromDueDate ?? null;
    if (hasFieldChange(event, "AssigneeId"))
      assigneeId = event.fromAssigneeId ?? null;
    if (hasFieldChange(event, "CycleId")) cycleId = event.fromCycleId ?? null;
  }

  return {
    deliveredAt: new Date(deliveredAtMilliseconds).toISOString(),
    dueDate,
    assigneeId,
    cycleId,
  };
}

/** Open tasks accrue lateness today; reviewed/completed tasks stop at delivery. */
export function resolveTaskSnapshot(
  current: IssueValuesAtNow & {
    stateId?: string;
    stateType?: string;
    completedAt?: Date | string | null;
  },
  history: readonly IssueHistoryEventLike[],
  reviewStateId: string,
  now: Date | string,
): { snapshot: DeliverySnapshot; pending: boolean } | null {
  if (current.stateType === "canceled" || current.stateType === "duplicate")
    return null;
  const pending =
    current.stateId !== reviewStateId && current.stateType !== "completed";
  if (pending) {
    return {
      snapshot: {
        deliveredAt: new Date(timestamp(now)).toISOString(),
        dueDate: current.dueDate ?? null,
        assigneeId: current.assigneeId ?? null,
        cycleId: current.cycleId ?? null,
      },
      pending: true,
    };
  }
  let snapshot = reconstructDeliverySnapshot(current, history, reviewStateId);
  if (!snapshot && current.stateType === "completed" && current.completedAt) {
    // Direct completion still has a delivery date, even without a Review step.
    snapshot = reconstructDeliverySnapshot(
      current,
      [
        ...history,
        { createdAt: current.completedAt, toStateId: reviewStateId },
      ],
      reviewStateId,
    );
  }
  return snapshot ? { snapshot, pending: false } : null;
}

/** Explains why an issue associated with a sprint cannot be counted as a delivery. */
export function getIncompleteSprintReason(
  snapshot: DeliverySnapshot | null,
  currentCycleId: string | null | undefined,
  history: readonly IssueHistoryEventLike[],
  sprintId: string,
): string | null {
  const isAssociatedWithSprint =
    currentCycleId === sprintId ||
    history.some(
      (event) => event.fromCycleId === sprintId || event.toCycleId === sprintId,
    );

  if (!isAssociatedWithSprint) return null;
  if (!snapshot)
    return "No transition into In Review was found and no completion timestamp is available for this sprint.";
  if (!snapshot.cycleId)
    return "The sprint at delivery could not be reconstructed from issue history.";
  return null;
}

function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-"))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** Returns the calendar day of an instant in Buenos Aires. */
export function getBuenosAiresCalendarDate(value: Date | string): string {
  const date = new Date(timestamp(value));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUENOS_AIRES_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const dateParts = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

/** Counts calendar days past the due date using Buenos Aires delivery dates. */
export function calculateDaysLate(
  dueDate: string,
  deliveredAt: Date | string,
): number {
  if (!isValidCalendarDate(dueDate)) {
    throw new RangeError("Linear returned an invalid due date.");
  }

  const deliveryDate = getBuenosAiresCalendarDate(deliveredAt);
  const dueDay = Date.parse(`${dueDate}T00:00:00.000Z`);
  const deliveryDay = Date.parse(`${deliveryDate}T00:00:00.000Z`);
  return Math.max(0, Math.floor((deliveryDay - dueDay) / 86_400_000));
}

export type LateBucket = keyof DeliveryCounts;

export function getLateBucket(daysLate: number): LateBucket | null {
  if (daysLate <= 0) return null;
  if (daysLate === 1) return "one";
  if (daysLate <= 3) return "twoThree";
  if (daysLate <= 5) return "fourFive";
  return "overFive";
}
