import type { IssueHistoryEventLike } from "./linear.js";
import type {
  LinearMetadata,
  LinearPage,
  LinearTaskData,
} from "./sync-types.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const DEFAULT_TEAM_ID = "1334836d-3538-443b-a490-524d01b39f85";
const DEFAULT_REVIEW_STATE_ID = "fbe5afc8-b5e0-49b8-a35c-7df803ee0472";
const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 10_000;
const RATE_LIMIT_FALLBACK_MS = 15 * 60 * 1000;

type GraphQLErrorLike = {
  extensions?: Record<string, unknown> | null;
};

type GraphQLResponse<T> = {
  data?: T | null;
  errors?: GraphQLErrorLike[] | null;
};

type PageInfo = {
  hasNextPage?: boolean | null;
  endCursor?: string | null;
};

type Connection<T> = {
  nodes?: T[] | null;
  pageInfo?: PageInfo | null;
};

type RawUser = {
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
  app?: boolean | null;
};

type RawIssue = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
  url?: string | null;
  team?: { id?: string | null } | null;
  cycle?: { id?: string | null } | null;
  assignee?: RawUser | null;
  state?: { id?: string | null; name?: string | null; type?: string | null } | null;
  dueDate?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
};

type RawCycle = {
  id?: string | null;
  name?: string | null;
  number?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
};

type RawWorkflowState = {
  id?: string | null;
  name?: string | null;
};

type RawHistoryEvent = {
  createdAt?: string | null;
  fromAssigneeId?: string | null;
  fromCycleId?: string | null;
  fromDueDate?: string | null;
  fromStateId?: string | null;
  toAssigneeId?: string | null;
  toCycleId?: string | null;
  toDueDate?: string | null;
  toStateId?: string | null;
};

type RateLimitMetadata = {
  requestLimit: string | null;
  requestsRemaining: string | null;
  complexity: string | null;
  complexityLimit: string | null;
  complexityRemaining: string | null;
  endpointName: string | null;
  endpointRequestLimit: string | null;
  endpointRequestsRemaining: string | null;
};

export class LinearApiError extends Error {
  readonly rateLimited: boolean;
  readonly retryAt: Date | null;

  constructor(message: string, rateLimited = false, retryAt: Date | null = null) {
    super(message);
    this.name = "LinearApiError";
    this.rateLimited = rateLimited;
    this.retryAt = retryAt;
  }
}

function getRequestTimeout(deadline?: number): {
  timeoutMs: number;
  deadlineBounded: boolean;
} {
  if (deadline === undefined) {
    return { timeoutMs: REQUEST_TIMEOUT_MS, deadlineBounded: false };
  }
  if (!Number.isFinite(deadline)) {
    throw new LinearApiError("Linear request deadline is invalid.");
  }

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new LinearApiError("Linear request deadline exceeded.");
  }
  return {
    timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remainingMs),
    deadlineBounded: remainingMs <= REQUEST_TIMEOUT_MS,
  };
}

const TEAM_CYCLES_QUERY = `
  query TeamCycles($teamId: String!, $first: Int!, $after: String) {
    team(id: $teamId) {
      cycles(first: $first, after: $after, includeArchived: true) {
        nodes { id name number startsAt endsAt }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const TEAM_MEMBERS_QUERY = `
  query TeamMembers($teamId: String!, $first: Int!, $after: String) {
    team(id: $teamId) {
      members(first: $first, after: $after, includeArchived: true) {
        nodes { id name displayName app }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const TEAM_STATES_QUERY = `
  query TeamStates($teamId: String!, $first: Int!, $after: String) {
    team(id: $teamId) {
      states(first: $first, after: $after, includeArchived: true) {
        nodes { id name }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const USER_QUERY = `
  query UserById($id: String!) {
    user(id: $id) { id name displayName app }
  }
`;

const TEAM_ISSUES_QUERY = `
  query TeamIssues($teamId: String!, $first: Int!, $after: String, $filter: IssueFilter) {
    team(id: $teamId) {
      issues(first: $first, after: $after, includeArchived: true, filter: $filter) {
        nodes {
          id identifier title url
          team { id }
          cycle { id }
          assignee { id name displayName }
          state { id name type }
          dueDate updatedAt completedAt
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const ISSUE_QUERY = `
  query IssueById($id: String!) {
    issue(id: $id) {
      id identifier title url
      team { id }
      cycle { id }
      assignee { id name displayName }
      state { id name type }
      dueDate updatedAt completedAt
    }
  }
`;

const ISSUE_HISTORY_QUERY = `
  query IssueHistory($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      history(first: $first, after: $after, includeArchived: true, orderBy: createdAt) {
        nodes {
          createdAt
          fromAssigneeId toAssigneeId
          fromCycleId toCycleId
          fromDueDate toDueDate
          fromStateId toStateId
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export function getLinearTeamId(): string {
  return process.env.LINEAR_TEAM_ID?.trim() || DEFAULT_TEAM_ID;
}

export function getLinearReviewStateId(): string {
  return process.env.LINEAR_REVIEW_STATE_ID?.trim() || DEFAULT_REVIEW_STATE_ID;
}

function readHeader(response: Response, name: string): string | null {
  const value = response.headers.get(name)?.trim();
  return value || null;
}

function getRateLimitMetadata(response: Response): RateLimitMetadata {
  return {
    requestLimit: readHeader(response, "x-ratelimit-requests-limit"),
    requestsRemaining: readHeader(response, "x-ratelimit-requests-remaining"),
    complexity: readHeader(response, "x-complexity"),
    complexityLimit: readHeader(response, "x-ratelimit-complexity-limit"),
    complexityRemaining: readHeader(response, "x-ratelimit-complexity-remaining"),
    endpointName: readHeader(response, "x-ratelimit-endpoint-name"),
    endpointRequestLimit: readHeader(response, "x-ratelimit-endpoint-requests-limit"),
    endpointRequestsRemaining: readHeader(
      response,
      "x-ratelimit-endpoint-requests-remaining",
    ),
  };
}

function logRateLimitMetadata(
  operation: string,
  response: Response,
  metadata: RateLimitMetadata,
): void {
  const fields = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== null),
  );
  if (Object.keys(fields).length === 0) return;
  console.debug("Linear API rate-limit metadata", {
    operation,
    httpStatus: response.status,
    ...fields,
  });
}

function parseResetTimestamp(value: string | null): Date | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const milliseconds = Math.abs(parsed) < 1_000_000_000_000 ? parsed * 1000 : parsed;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseRetryAfter(value: string | null): Date | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(Date.now() + seconds * 1000);
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function getRetryAt(response: Response): Date {
  const resetDates = [
    parseResetTimestamp(readHeader(response, "x-ratelimit-complexity-reset")),
    parseResetTimestamp(readHeader(response, "x-ratelimit-requests-reset")),
    parseResetTimestamp(
      readHeader(response, "x-ratelimit-endpoint-requests-reset"),
    ),
    parseRetryAfter(readHeader(response, "retry-after")),
  ].filter((value): value is Date => value !== null);
  if (resetDates.length === 0) {
    return new Date(Date.now() + RATE_LIMIT_FALLBACK_MS);
  }
  return new Date(Math.max(...resetDates.map((value) => value.getTime())));
}

function isRateLimited(
  status: number,
  errors: GraphQLErrorLike[] | null | undefined,
): boolean {
  if (status === 429) return true;
  return (
    errors?.some((error) => {
      const extensions = error.extensions;
      const code = String(extensions?.code ?? "").toUpperCase();
      return (
        code === "RATELIMITED" ||
        code === "429" ||
        Number(extensions?.status) === 429 ||
        Number(extensions?.statusCode) === 429
      );
    }) ?? false
  );
}

async function requestGraphQL<T>(
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  deadline?: number,
): Promise<T> {
  const { timeoutMs, deadlineBounded } = getRequestTimeout(deadline);
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) throw new LinearApiError("Set LINEAR_API_KEY on the server.");

  let response: Response;
  try {
    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut && deadlineBounded) {
      throw new LinearApiError("Linear request deadline exceeded.");
    }
    throw new LinearApiError(
      timedOut ? "Linear request timed out." : "Linear request failed.",
    );
  }

  if (deadline !== undefined && Date.now() >= deadline) {
    throw new LinearApiError("Linear request deadline exceeded.");
  }

  const rateLimitMetadata = getRateLimitMetadata(response);
  logRateLimitMetadata(operation, response, rateLimitMetadata);

  let payload: GraphQLResponse<T> | null = null;
  try {
    payload = (await response.json()) as GraphQLResponse<T>;
  } catch {
    // The safe error below intentionally omits the response body.
  }

  if (!response.ok || payload?.errors?.length) {
    const rateLimited = isRateLimited(response.status, payload?.errors);
    const retryAt = rateLimited ? getRetryAt(response) : null;
    const status = response.status ? ` (HTTP ${response.status})` : "";
    throw new LinearApiError(
      `Linear ${operation} request failed${status}.`,
      rateLimited,
      retryAt,
    );
  }

  if (!payload?.data) {
    throw new LinearApiError(`Linear ${operation} returned no data.`);
  }
  return payload.data;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toIsoDateTime(value: string | null | undefined): string | null {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new LinearApiError("Linear returned an invalid date.");
  }
  return date.toISOString();
}

function mapTask(issue: RawIssue): LinearTaskData {
  const id = requiredString(issue.id);
  const identifier = requiredString(issue.identifier);
  const title = requiredString(issue.title);
  const url = requiredString(issue.url);
  const teamId = requiredString(issue.team?.id);
  const stateId = requiredString(issue.state?.id);
  const stateName = requiredString(issue.state?.name);
  const stateType = requiredString(issue.state?.type);
  const updatedAt = toIsoDateTime(issue.updatedAt);
  if (
    !id ||
    !identifier ||
    !title ||
    !url ||
    !teamId ||
    !stateId ||
    !stateName ||
    !stateType ||
    !updatedAt
  ) {
    throw new LinearApiError("Linear returned incomplete task data.");
  }

  const assigneeName = issue.assignee
    ? issue.assignee.name?.trim() || issue.assignee.displayName?.trim() || null
    : null;

  return {
    id,
    identifier,
    title,
    url,
    teamId,
    sprintId: requiredString(issue.cycle?.id),
    assigneeId: requiredString(issue.assignee?.id),
    assigneeName,
    stateId,
    stateName,
    stateType,
    dueDate: issue.dueDate ?? null,
    updatedAt,
    completedAt: toIsoDateTime(issue.completedAt),
  };
}

function getConnection<T>(
  value: Connection<T> | null | undefined,
  operation: string,
): Connection<T> & { nodes: T[]; pageInfo: PageInfo } {
  if (!value || !value.pageInfo) {
    throw new LinearApiError(`Linear ${operation} returned an incomplete page.`);
  }
  return {
    nodes: value.nodes ?? [],
    pageInfo: value.pageInfo,
  };
}

async function fetchAllConnectionPages<T, TData>(args: {
  operation: string;
  query: string;
  variables: (after: string | null) => Record<string, unknown>;
  connection: (data: TData) => Connection<T> | null | undefined;
  deadline?: number;
}): Promise<T[]> {
  const nodes: T[] = [];
  const seenCursors = new Set<string>();
  let after: string | null = null;

  while (true) {
    const data = await requestGraphQL<TData>(
      args.operation,
      args.query,
      args.variables(after),
      args.deadline,
    );
    const page = getConnection(args.connection(data), args.operation);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;

    const cursor = requiredString(page.pageInfo.endCursor);
    if (!cursor || seenCursors.has(cursor)) {
      throw new LinearApiError(
        `Linear ${args.operation} returned an invalid pagination cursor.`,
      );
    }
    seenCursors.add(cursor);
    after = cursor;
  }
}

function normalizedStateName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isHumanUser(user: RawUser): boolean {
  return user.app !== true;
}

function userName(user: RawUser): string {
  return user.name?.trim() || user.displayName?.trim() || "";
}

function parseStudentAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
}

function mapStudent(user: RawUser): { id: string; name: string } | null {
  const id = requiredString(user.id);
  if (!id || !isHumanUser(user)) return null;
  return { id, name: userName(user) };
}

async function fetchTeamCycles(
  teamId: string,
  deadline?: number,
): Promise<RawCycle[]> {
  return fetchAllConnectionPages<RawCycle, { team?: { cycles?: Connection<RawCycle> | null } | null }>({
    operation: "team cycles",
    query: TEAM_CYCLES_QUERY,
    variables: (after) => ({ teamId, first: PAGE_SIZE, after }),
    connection: (data) => data.team?.cycles,
    deadline,
  });
}

async function fetchTeamMembers(
  teamId: string,
  deadline?: number,
): Promise<RawUser[]> {
  return fetchAllConnectionPages<RawUser, { team?: { members?: Connection<RawUser> | null } | null }>({
    operation: "team members",
    query: TEAM_MEMBERS_QUERY,
    variables: (after) => ({ teamId, first: PAGE_SIZE, after }),
    connection: (data) => data.team?.members,
    deadline,
  });
}

async function fetchTeamStates(
  teamId: string,
  deadline?: number,
): Promise<RawWorkflowState[]> {
  return fetchAllConnectionPages<RawWorkflowState, { team?: { states?: Connection<RawWorkflowState> | null } | null }>({
    operation: "team states",
    query: TEAM_STATES_QUERY,
    variables: (after) => ({ teamId, first: PAGE_SIZE, after }),
    connection: (data) => data.team?.states,
    deadline,
  });
}

async function fetchUser(
  id: string,
  deadline?: number,
): Promise<RawUser | null> {
  const data = await requestGraphQL<{ user?: RawUser | null }>(
    "user by id",
    USER_QUERY,
    { id },
    deadline,
  );
  return data.user ?? null;
}

export async function fetchMetadata(
  deadline?: number,
): Promise<LinearMetadata> {
  const teamId = getLinearTeamId();
  const [cycles, members, states] = await Promise.all([
    fetchTeamCycles(teamId, deadline),
    fetchTeamMembers(teamId, deadline),
    fetchTeamStates(teamId, deadline),
  ]);

  const allowlist = parseStudentAllowlist(process.env.LINEAR_STUDENT_IDS);
  const students = new Map<string, { id: string; name: string }>();
  for (const member of members) {
    const id = requiredString(member.id);
    if (!id || !isHumanUser(member)) continue;
    if (allowlist.size > 0 && !allowlist.has(id.toLowerCase())) continue;
    const student = mapStudent(member);
    if (student) students.set(student.id, student);
  }

  const missingAllowlistedIds = [...allowlist].filter(
    (id) => ![...students.keys()].some((studentId) => studentId.toLowerCase() === id),
  );
  const missingUsers = await Promise.all(
    missingAllowlistedIds.map((id) => fetchUser(id, deadline)),
  );
  for (const user of missingUsers) {
    if (!user) continue;
    const student = mapStudent(user);
    if (student) students.set(student.id, student);
  }

  const stateIdsByName = new Map<string, string[]>();
  for (const state of states) {
    const id = requiredString(state.id);
    const name = requiredString(state.name);
    if (!id || !name) continue;
    const normalizedName = normalizedStateName(name);
    if (normalizedName !== "todo" && normalizedName !== "inprogress") continue;
    const ids = stateIdsByName.get(normalizedName) ?? [];
    ids.push(id);
    stateIdsByName.set(normalizedName, ids);
  }

  if (!stateIdsByName.has("todo") || !stateIdsByName.has("inprogress")) {
    throw new LinearApiError(
      "Linear team is missing the required To Do or In Progress workflow state.",
    );
  }

  const sprints = cycles.map((cycle) => {
    const id = requiredString(cycle.id);
    const startsAt = toIsoDateTime(cycle.startsAt);
    const endsAt = toIsoDateTime(cycle.endsAt);
    if (!id || !startsAt || !endsAt) {
      throw new LinearApiError("Linear returned incomplete cycle data.");
    }
    return {
      id,
      name: cycle.name?.trim() || `Cycle ${cycle.number ?? ""}`.trim(),
      startsAt,
      endsAt,
    };
  });
  sprints.sort((left, right) => left.startsAt.localeCompare(right.startsAt));

  return {
    sprints,
    students: [...students.values()],
    openStateIds: [
      ...new Set([
        ...(stateIdsByName.get("todo") ?? []),
        ...(stateIdsByName.get("inprogress") ?? []),
      ]),
    ],
  };
}

function issueFilter(args: {
  teamId: string;
  sprintId?: string;
  openStateIds?: string[];
}): Record<string, unknown> {
  return {
    team: { id: { eq: args.teamId } },
    ...(args.sprintId
      ? { cycle: { id: { eq: args.sprintId } } }
      : {}),
    ...(args.openStateIds
      ? { state: { id: { in: args.openStateIds } } }
      : {}),
  };
}

async function fetchTaskPage(
  after: string | null,
  filter: Record<string, unknown>,
  deadline?: number,
): Promise<LinearPage> {
  const teamId = getLinearTeamId();
  const data = await requestGraphQL<{
    team?: { issues?: Connection<RawIssue> | null } | null;
  }>(
    "team issues",
    TEAM_ISSUES_QUERY,
    {
      teamId,
      first: PAGE_SIZE,
      after,
      filter,
    },
    deadline,
  );
  const connection = getConnection(data.team?.issues, "team issues");
  const nextCursor = connection.pageInfo.hasNextPage
    ? requiredString(connection.pageInfo.endCursor)
    : null;
  if (connection.pageInfo.hasNextPage && !nextCursor) {
    throw new LinearApiError("Linear team issues returned an invalid cursor.");
  }
  return {
    tasks: connection.nodes.map(mapTask),
    nextCursor,
  };
}

export async function fetchOpenTasksPage(
  sprintId: string,
  openStateIds: string[],
  after: string | null,
  deadline?: number,
): Promise<LinearPage> {
  const explicitOpenStateIds = [...new Set(openStateIds.map((id) => id.trim()).filter(Boolean))];
  if (explicitOpenStateIds.length === 0) {
    return { tasks: [], nextCursor: null };
  }
  return fetchTaskPage(
    after,
    issueFilter({
      teamId: getLinearTeamId(),
      sprintId,
      openStateIds: explicitOpenStateIds,
    }),
    deadline,
  );
}

export async function fetchAllTasksPage(
  after: string | null,
  deadline?: number,
): Promise<LinearPage> {
  return fetchTaskPage(
    after,
    issueFilter({ teamId: getLinearTeamId() }),
    deadline,
  );
}

export async function fetchTask(
  id: string,
  deadline?: number,
): Promise<LinearTaskData | null> {
  const data = await requestGraphQL<{ issue?: RawIssue | null }>(
    "issue by id",
    ISSUE_QUERY,
    { id },
    deadline,
  );
  return data.issue ? mapTask(data.issue) : null;
}

export async function fetchTaskHistory(
  id: string,
  deadline?: number,
): Promise<IssueHistoryEventLike[]> {
  const events = await fetchAllConnectionPages<
    RawHistoryEvent,
    { issue?: { history?: Connection<RawHistoryEvent> | null } | null }
  >({
    operation: "issue history",
    query: ISSUE_HISTORY_QUERY,
    variables: (after) => ({ id, first: PAGE_SIZE, after }),
    deadline,
    connection: (data) =>
      data.issue
        ? data.issue.history
        : { nodes: [], pageInfo: { hasNextPage: false } },
  });

  return events.map((event) => {
    const createdAt = toIsoDateTime(event.createdAt);
    if (!createdAt) {
      throw new LinearApiError("Linear returned incomplete issue history data.");
    }
    return {
      createdAt,
      fromAssigneeId: event.fromAssigneeId,
      fromCycleId: event.fromCycleId,
      fromDueDate: event.fromDueDate,
      fromStateId: event.fromStateId,
      toAssigneeId: event.toAssigneeId,
      toCycleId: event.toCycleId,
      toDueDate: event.toDueDate,
      toStateId: event.toStateId,
    };
  });
}
