import {
  LinearClient,
  PaginationOrderBy,
  type Issue,
  type IssueHistory,
  type User,
} from "@linear/sdk";

const DEFAULT_TEAM_ID = "1334836d-3538-443b-a490-524d01b39f85";
const DEFAULT_REVIEW_STATE_ID = "fbe5afc8-b5e0-49b8-a35c-7df803ee0472";
const PAGE_SIZE = 100;
const HISTORY_CONCURRENCY = 8;
const BUENOS_AIRES_TIME_ZONE = "America/Argentina/Buenos_Aires";

export interface Sprint {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
}

export interface DeliveryCounts {
  one: number;
  twoThree: number;
  fourFive: number;
  overFive: number;
}

export interface StudentDeliverySummary {
  id: string;
  name: string;
  counts: DeliveryCounts;
}

export interface DeliveryIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  studentId: string;
  studentName: string;
  deliveredAt: string;
  dueDate: string;
  daysLate: number;
  bucket: LateBucket;
}

export interface IncompleteDelivery {
  identifier: string;
  reason: string;
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

export function parseStudentAllowlist(value: string | undefined | null): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isStudentAllowed(id: string, allowlist: ReadonlySet<string>): boolean {
  return allowlist.size === 0 || allowlist.has(id.trim().toLowerCase());
}

let cachedClient: LinearClient | undefined;
let cachedApiKey: string | undefined;

function getLinearClient(): LinearClient {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("Set LINEAR_API_KEY on the server.");
  }

  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedClient = new LinearClient({ apiKey });
    cachedApiKey = apiKey;
  }

  return cachedClient;
}

function getTeamId(): string {
  return process.env.LINEAR_TEAM_ID?.trim() || DEFAULT_TEAM_ID;
}

function getReviewStateId(): string {
  return process.env.LINEAR_REVIEW_STATE_ID?.trim() || DEFAULT_REVIEW_STATE_ID;
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index]);
      }
    }),
  );

  return results;
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
    return "No transition into In Review was found in the issue history for this sprint.";
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

function emptyCounts(): DeliveryCounts {
  return { one: 0, twoThree: 0, fourFive: 0, overFive: 0 };
}

function incrementCount(counts: DeliveryCounts, bucket: LateBucket): void {
  counts[bucket] += 1;
}

function userName(user: Pick<User, "name" | "displayName">): string {
  return user.name.trim() || user.displayName.trim();
}

function isHumanUser(user: {
  app?: boolean;
  isAppUser?: boolean;
  isBot?: boolean;
}): boolean {
  return user.app !== true && user.isAppUser !== true && user.isBot !== true;
}

async function getTeamIssues(
  team: Awaited<ReturnType<LinearClient["team"]>>,
): Promise<Issue[]> {
  return collectAllPages(
    await team.issues({ first: PAGE_SIZE, includeArchived: true }),
  );
}

async function getIssueHistory(issue: Issue): Promise<IssueHistory[]> {
  return collectAllPages(
    await issue.history({
      first: PAGE_SIZE,
      includeArchived: true,
      orderBy: PaginationOrderBy.CreatedAt,
    }),
  );
}

export async function getSprints(): Promise<Sprint[]> {
  const team = await getLinearClient().team(getTeamId());
  const cycles = await collectAllPages(
    await team.cycles({
      first: PAGE_SIZE,
      includeArchived: true,
      orderBy: PaginationOrderBy.CreatedAt,
    }),
  );

  return cycles
    .map((cycle) => ({
      id: cycle.id,
      name: cycle.name?.trim() || `Cycle ${cycle.number}`,
      startsAt: cycle.startsAt.toISOString(),
      endsAt: cycle.endsAt.toISOString(),
    }))
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

export async function getDeliveries(sprintId: string): Promise<{
  students: StudentDeliverySummary[];
  issues: DeliveryIssue[];
  incomplete: IncompleteDelivery[];
}> {
  if (!sprintId.trim()) throw new Error("Select a sprint.");

  const client = getLinearClient();
  const team = await client.team(getTeamId());
  const [issues, members, states] = await Promise.all([
    getTeamIssues(team),
    collectAllPages(
      await team.members({ first: PAGE_SIZE, includeArchived: true }),
    ),
    collectAllPages(
      await team.states({ first: PAGE_SIZE, includeArchived: true }),
    ),
  ]);
  const studentAllowlist = parseStudentAllowlist(
    process.env.LINEAR_STUDENT_IDS,
  );
  const uniqueIssues = [
    ...new Map(issues.map((issue) => [issue.id, issue])).values(),
  ];
  const stateTypes = new Map(states.map((state) => [state.id, state.type]));
  const roster = new Map<string, StudentDeliverySummary>();

  for (const member of members) {
    if (
      !isHumanUser(member) ||
      !isStudentAllowed(member.id, studentAllowlist)
    ) {
      continue;
    }
    roster.set(member.id, {
      id: member.id,
      name: userName(member),
      counts: emptyCounts(),
    });
  }

  const missingAllowlistedUsers = [...studentAllowlist].filter(
    (id) => !roster.has(id),
  );
  const allowlistedUsers = await mapWithConcurrency(
    missingAllowlistedUsers,
    HISTORY_CONCURRENCY,
    async (id) => {
      try {
        return await client.user(id);
      } catch {
        return null;
      }
    },
  );
  for (const user of allowlistedUsers) {
    if (!user || !isHumanUser(user)) continue;
    roster.set(user.id, {
      id: user.id,
      name: userName(user),
      counts: emptyCounts(),
    });
  }

  const histories = await mapWithConcurrency(
    uniqueIssues,
    HISTORY_CONCURRENCY,
    getIssueHistory,
  );
  const eligibleDeliveries: Array<{
    issue: Issue;
    snapshot: DeliverySnapshot;
  }> = [];
  const incomplete: IncompleteDelivery[] = [];
  const reviewStateId = getReviewStateId();

  for (let index = 0; index < uniqueIssues.length; index += 1) {
    const issue = uniqueIssues[index];
    const history = histories[index];
    const currentStateType = stateTypes.get(issue.stateId ?? "");
    if (currentStateType === "canceled" || currentStateType === "duplicate")
      continue;

    const snapshot = reconstructDeliverySnapshot(
      {
        dueDate: issue.dueDate,
        assigneeId: issue.assigneeId,
        cycleId: issue.cycleId,
      },
      history,
      reviewStateId,
    );
    const assigneeAtDelivery = snapshot
      ? snapshot.assigneeId
      : issue.assigneeId;
    if (
      assigneeAtDelivery &&
      !isStudentAllowed(assigneeAtDelivery, studentAllowlist)
    ) {
      continue;
    }

    const missingSprintReason = getIncompleteSprintReason(
      snapshot,
      issue.cycleId,
      history,
      sprintId,
    );
    if (missingSprintReason) {
      incomplete.push({
        identifier: issue.identifier,
        reason: missingSprintReason,
      });
      continue;
    }
    if (!snapshot || snapshot.cycleId !== sprintId) continue;

    eligibleDeliveries.push({ issue, snapshot });
  }

  const historicAssigneeIds = [
    ...new Set(
      eligibleDeliveries
        .map(({ snapshot }) => snapshot.assigneeId)
        .filter((id): id is string => Boolean(id) && !roster.has(id!))
        .filter((id) => isStudentAllowed(id, studentAllowlist)),
    ),
  ];
  const historicUsers = await mapWithConcurrency(
    historicAssigneeIds,
    HISTORY_CONCURRENCY,
    async (id) => {
      try {
        return await client.user(id);
      } catch {
        return null;
      }
    },
  );
  for (const user of historicUsers) {
    if (!user || !isHumanUser(user)) continue;
    roster.set(user.id, {
      id: user.id,
      name: userName(user),
      counts: emptyCounts(),
    });
  }

  const results = eligibleDeliveries.map(({ issue, snapshot }) => {
    const reasons: string[] = [];
    if (!snapshot.dueDate || !isValidCalendarDate(snapshot.dueDate)) {
      reasons.push("No valid due date was set at delivery.");
    }

    const student = snapshot.assigneeId
      ? roster.get(snapshot.assigneeId)
      : undefined;
    if (!snapshot.assigneeId) {
      reasons.push("No assignee was set at delivery.");
    } else if (!student) {
      reasons.push(
        "The assignee at delivery is not a human team member or could not be resolved.",
      );
    }

    if (reasons.length > 0 || !snapshot.dueDate || !student) {
      return {
        issue: null,
        incomplete: { identifier: issue.identifier, reason: reasons.join(" ") },
      };
    }

    let daysLate: number;
    try {
      daysLate = calculateDaysLate(snapshot.dueDate, snapshot.deliveredAt);
    } catch {
      return {
        issue: null,
        incomplete: {
          identifier: issue.identifier,
          reason: "Delivery timestamp or due date could not be interpreted.",
        },
      };
    }

    const bucket = getLateBucket(daysLate);
    if (!bucket) return { issue: null, incomplete: null };

    incrementCount(student.counts, bucket);

    return {
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        studentId: student.id,
        studentName: student.name,
        deliveredAt: snapshot.deliveredAt,
        dueDate: snapshot.dueDate,
        daysLate,
        bucket,
      },
      incomplete: null,
    };
  });

  return {
    students: [...roster.values()].sort(
      (left, right) =>
        left.name.localeCompare(right.name, "en", { sensitivity: "base" }) ||
        left.id.localeCompare(right.id),
    ),
    issues: results.flatMap((result) => (result.issue ? [result.issue] : [])),
    incomplete: [
      ...incomplete,
      ...results.flatMap((result) =>
        result.incomplete ? [result.incomplete] : [],
      ),
    ],
  };
}
