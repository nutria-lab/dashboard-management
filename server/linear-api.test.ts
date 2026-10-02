import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAllTasksPage,
  fetchMetadata,
  fetchOpenTasksPage,
  fetchTask,
  fetchTaskHistory,
  getLinearReviewStateId,
  getLinearTeamId,
  LinearApiError,
} from "./linear-api.js";

const DEFAULT_TEAM_ID = "1334836d-3538-443b-a490-524d01b39f85";
const DEFAULT_REVIEW_STATE_ID = "fbe5afc8-b5e0-49b8-a35c-7df803ee0472";

function jsonResponse(payload: unknown, options?: { status?: number; headers?: HeadersInit }) {
  return new Response(JSON.stringify(payload), {
    status: options?.status ?? 200,
    headers: options?.headers,
  });
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  if (!init || typeof init.body !== "string") throw new Error("Missing request body");
  return JSON.parse(init.body) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

beforeEach(() => {
  vi.stubEnv("LINEAR_API_KEY", "linear-test-key");
  vi.stubEnv("LINEAR_TEAM_ID", "");
  vi.stubEnv("LINEAR_REVIEW_STATE_ID", "");
  vi.stubEnv("LINEAR_STUDENT_IDS", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Linear transport defaults", () => {
  it("uses the configured team and review state IDs with the requested defaults", () => {
    expect(getLinearTeamId()).toBe(DEFAULT_TEAM_ID);
    expect(getLinearReviewStateId()).toBe(DEFAULT_REVIEW_STATE_ID);

    vi.stubEnv("LINEAR_TEAM_ID", " team-custom ");
    vi.stubEnv("LINEAR_REVIEW_STATE_ID", " review-custom ");
    expect(getLinearTeamId()).toBe("team-custom");
    expect(getLinearReviewStateId()).toBe("review-custom");
  });
});

describe("task queries", () => {
  it("maps an open task page and sends explicit team, sprint, and state filters", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          team: {
            issues: {
              nodes: [
                {
                  id: "issue-1",
                  identifier: "NUT-1",
                  title: "Prepare ingredients",
                  url: "https://linear.app/nutria/issue/NUT-1",
                  team: { id: DEFAULT_TEAM_ID },
                  cycle: { id: "cycle-1" },
                  assignee: {
                    id: "student-1",
                    name: " Lara ",
                    displayName: "Lara Display",
                  },
                  state: { id: "state-progress", name: "In Progress", type: "started" },
                  dueDate: "2026-10-06",
                  updatedAt: "2026-10-02T12:30:00-03:00",
                  completedAt: null,
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "issue-cursor-50" },
            },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchOpenTasksPage("cycle-1", ["state-todo", "state-progress"], null),
    ).resolves.toEqual({
      tasks: [
        {
          id: "issue-1",
          identifier: "NUT-1",
          title: "Prepare ingredients",
          url: "https://linear.app/nutria/issue/NUT-1",
          teamId: DEFAULT_TEAM_ID,
          sprintId: "cycle-1",
          assigneeId: "student-1",
          assigneeName: "Lara",
          stateId: "state-progress",
          stateName: "In Progress",
          stateType: "started",
          dueDate: "2026-10-06",
          updatedAt: "2026-10-02T15:30:00.000Z",
          completedAt: null,
        },
      ],
      nextCursor: "issue-cursor-50",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect(new Headers(init.headers).get("authorization")).toBe("linear-test-key");
    expect(new Headers(init.headers).get("authorization")).not.toContain("Bearer ");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = requestBody(fetchMock);
    expect(body.variables).toEqual({
      teamId: DEFAULT_TEAM_ID,
      first: 50,
      after: null,
      filter: {
        team: { id: { eq: DEFAULT_TEAM_ID } },
        cycle: { id: { eq: "cycle-1" } },
        state: { id: { in: ["state-todo", "state-progress"] } },
      },
    });
    expect(body.query).toContain("state { id name type }");
    expect(body.query).toContain("assignee { id name displayName }");
    expect(body.query).not.toContain("description");
    expect(body.query).not.toContain("fragment Issue");
  });

  it("keeps all-task import pages scoped to the team and maps single-task lookups", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            team: {
              issues: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              id: "issue-2",
              identifier: "NUT-2",
              title: "Add nutrition facts",
              url: "https://linear.app/nutria/issue/NUT-2",
              team: { id: DEFAULT_TEAM_ID },
              cycle: null,
              assignee: null,
              state: { id: "done", name: "Done", type: "completed" },
              dueDate: null,
              updatedAt: "2026-10-02T15:00:00Z",
              completedAt: "2026-10-02T15:00:00Z",
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllTasksPage("cursor-before")).resolves.toEqual({
      tasks: [],
      nextCursor: null,
    });
    await expect(fetchTask("issue-2")).resolves.toMatchObject({
      id: "issue-2",
      stateId: "done",
      stateType: "completed",
      sprintId: null,
      assigneeId: null,
      completedAt: "2026-10-02T15:00:00.000Z",
    });

    const importRequest = requestBody(fetchMock, 0);
    expect(importRequest.variables).toEqual({
      teamId: DEFAULT_TEAM_ID,
      first: 50,
      after: "cursor-before",
      filter: { team: { id: { eq: DEFAULT_TEAM_ID } } },
    });
    expect(importRequest.query).not.toContain("state: {");
    expect(importRequest.query).not.toContain("cycle: {");
    expect(requestBody(fetchMock, 1).query).not.toContain("description");
  });
});

describe("metadata queries", () => {
  it("collects all cycle, member, and state pages and resolves only the named open states", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      if (body.query.includes("query TeamCycles")) {
        const secondPage = body.variables.after === "cycle-page-1";
        return jsonResponse({
          data: {
            team: {
              cycles: {
                nodes: [
                  secondPage
                    ? { id: "cycle-2", name: "Cycle Two", number: 2, startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-14T23:59:00Z" }
                    : { id: "cycle-1", name: "Cycle One", number: 1, startsAt: "2026-10-01T00:00:00-03:00", endsAt: "2026-10-14T23:59:00-03:00" },
                ],
                pageInfo: secondPage
                  ? { hasNextPage: false, endCursor: "cycle-page-2" }
                  : { hasNextPage: true, endCursor: "cycle-page-1" },
              },
            },
          },
        });
      }
      if (body.query.includes("query TeamMembers")) {
        const secondPage = body.variables.after === "member-page-1";
        return jsonResponse({
          data: {
            team: {
              members: {
                nodes: secondPage
                  ? [{ id: "student-2", name: "Majo", displayName: "Majo", app: false }]
                  : [
                      { id: "student-1", name: "Lara", displayName: "Lara", app: false },
                      { id: "bot-1", name: "Automation", displayName: "Automation", app: true },
                    ],
                pageInfo: secondPage
                  ? { hasNextPage: false, endCursor: "member-page-2" }
                  : { hasNextPage: true, endCursor: "member-page-1" },
              },
            },
          },
        });
      }
      if (body.query.includes("query TeamStates")) {
        const secondPage = body.variables.after === "state-page-1";
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: secondPage
                  ? [{ id: "state-progress", name: "IN   PROGRESS" }]
                  : [
                      { id: "state-todo", name: " To Do " },
                      { id: "state-review", name: "In Review" },
                    ],
                pageInfo: secondPage
                  ? { hasNextPage: false, endCursor: "state-page-2" }
                  : { hasNextPage: true, endCursor: "state-page-1" },
              },
            },
          },
        });
      }
      throw new Error("Unexpected GraphQL operation");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMetadata()).resolves.toEqual({
      sprints: [
        {
          id: "cycle-1",
          name: "Cycle One",
          startsAt: "2026-10-01T03:00:00.000Z",
          endsAt: "2026-10-15T02:59:00.000Z",
        },
        {
          id: "cycle-2",
          name: "Cycle Two",
          startsAt: "2026-11-01T00:00:00.000Z",
          endsAt: "2026-11-14T23:59:00.000Z",
        },
      ],
      students: [
        { id: "student-1", name: "Lara" },
        { id: "student-2", name: "Majo" },
      ],
      openStateIds: ["state-todo", "state-progress"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls.map((call) => requestBody(fetchMock, fetchMock.mock.calls.indexOf(call)).variables.first)).toEqual(
      [50, 50, 50, 50, 50, 50],
    );
  });

  it("queries minimal user fields for allowlisted IDs missing from team members", async () => {
    vi.stubEnv("LINEAR_STUDENT_IDS", "student-1,student-2,bot-1");
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      if (body.query.includes("query TeamCycles")) {
        return jsonResponse({ data: { team: { cycles: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      }
      if (body.query.includes("query TeamMembers")) {
        return jsonResponse({
          data: {
            team: {
              members: {
                nodes: [
                  { id: "student-1", name: "Lara", displayName: "Lara", app: false },
                  { id: "bot-1", name: "Automation", displayName: "Automation", app: true },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        });
      }
      if (body.query.includes("query TeamStates")) {
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "todo", name: "To Do" },
                  { id: "progress", name: "In Progress" },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        });
      }
      if (body.query.includes("query UserById")) {
        return jsonResponse({
          data: {
            user:
              body.variables.id === "student-2"
                ? { id: "student-2", name: "Fer", displayName: "Fer display", app: false }
                : { id: "bot-1", name: "Automation", displayName: "Automation", app: true },
          },
        });
      }
      throw new Error("Unexpected GraphQL operation");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMetadata()).resolves.toMatchObject({
      students: [
        { id: "student-1", name: "Lara" },
        { id: "student-2", name: "Fer" },
      ],
    });
    const userRequests = fetchMock.mock.calls
      .map((_, index) => requestBody(fetchMock, index))
      .filter((body) => body.query.includes("query UserById"));
    expect(userRequests.map((request) => request.variables.id)).toEqual([
      "student-2",
      "bot-1",
    ]);
    expect(userRequests[0]?.query).toContain("user(id: $id) { id name displayName app }");
    expect(userRequests[0]?.query).not.toContain("description");
  });

  it("fails when either required named open workflow state is missing", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes("query TeamCycles")) {
        return jsonResponse({ data: { team: { cycles: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      }
      if (body.query.includes("query TeamMembers")) {
        return jsonResponse({ data: { team: { members: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      }
      return jsonResponse({ data: { team: { states: { nodes: [{ id: "todo", name: "To Do" }], pageInfo: { hasNextPage: false } } } } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMetadata()).rejects.toThrow("missing the required To Do or In Progress");
  });
});

describe("history queries", () => {
  it("returns an empty history for an issue that no longer exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { issue: null } })),
    );

    await expect(fetchTaskHistory("deleted-issue")).resolves.toEqual([]);
  });

  it("maps relational history fields and fetches every page with minimal selections", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              history: {
                nodes: [
                  {
                    createdAt: "2026-10-01T12:00:00-03:00",
                    fromAssigneeId: "student-1",
                    toAssigneeId: "student-2",
                    fromCycleId: "cycle-1",
                    toCycleId: "cycle-2",
                    fromDueDate: "2026-10-05",
                    toDueDate: "2026-10-06",
                    fromStateId: "todo",
                    toStateId: "progress",
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: "history-cursor-1" },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              history: {
                nodes: [{ createdAt: "2026-10-02T12:00:00Z", fromDueDate: "2026-10-06", toDueDate: null }],
                pageInfo: { hasNextPage: false, endCursor: "history-cursor-2" },
              },
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTaskHistory("issue-1")).resolves.toEqual([
      {
        createdAt: "2026-10-01T15:00:00.000Z",
        fromAssigneeId: "student-1",
        toAssigneeId: "student-2",
        fromCycleId: "cycle-1",
        toCycleId: "cycle-2",
        fromDueDate: "2026-10-05",
        toDueDate: "2026-10-06",
        fromStateId: "todo",
        toStateId: "progress",
      },
      {
        createdAt: "2026-10-02T12:00:00.000Z",
        fromAssigneeId: undefined,
        toAssigneeId: undefined,
        fromCycleId: undefined,
        toCycleId: undefined,
        fromDueDate: "2026-10-06",
        toDueDate: null,
        fromStateId: undefined,
        toStateId: undefined,
      },
    ]);
    expect(requestBody(fetchMock, 1).variables).toEqual({
      id: "issue-1",
      first: 50,
      after: "history-cursor-1",
    });
    const historyQuery = requestBody(fetchMock, 0).query;
    expect(historyQuery).toContain("fromAssigneeId toAssigneeId");
    expect(historyQuery).toContain("fromCycleId toCycleId");
    expect(historyQuery).toContain("fromDueDate toDueDate");
    expect(historyQuery).not.toContain("actor {");
    expect(historyQuery).not.toContain("description");
  });
});

describe("rate-limit errors", () => {
  it("uses the latest complexity, request, and endpoint reset timestamp", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { errors: [{ extensions: { code: "RATELIMITED" } }] },
        {
          status: 400,
          headers: {
            "x-ratelimit-requests-reset": "2000000000000",
            "x-ratelimit-complexity-reset": "2000000001000",
            "x-ratelimit-endpoint-requests-reset": "2000000002000",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    let thrown: unknown;
    try {
      await fetchTask("issue-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LinearApiError);
    expect(thrown).toMatchObject({
      rateLimited: true,
      retryAt: new Date(2_000_000_002_000),
    });
    expect((thrown as Error).message).not.toContain("linear-test-key");
    expect((thrown as Error).message).not.toContain("RATELIMITED");
  });

  it("recognizes the GraphQL 429 code and falls back to fifteen minutes without reset headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
    const fetchMock = vi.fn(async () =>
      jsonResponse({ errors: [{ extensions: { code: 429 } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let thrown: unknown;
    try {
      await fetchTask("issue-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LinearApiError);
    expect(thrown).toMatchObject({
      rateLimited: true,
      retryAt: new Date("2026-10-02T12:15:00.000Z"),
    });
  });
});

describe("request deadlines", () => {
  it("rejects an expired deadline before calling fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTask("issue-1", Date.now())).rejects.toMatchObject({
      name: "LinearApiError",
      message: "Linear request deadline exceeded.",
      rateLimited: false,
      retryAt: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shares the deadline across metadata queries and caps every request timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
    const deadline = Date.now() + 2_500;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes("query TeamCycles")) {
        return jsonResponse({ data: { team: { cycles: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      }
      if (body.query.includes("query TeamMembers")) {
        return jsonResponse({ data: { team: { members: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      }
      return jsonResponse({
        data: {
          team: {
            states: {
              nodes: [
                { id: "todo", name: "To Do" },
                { id: "progress", name: "In Progress" },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchMetadata(deadline);

    expect(timeoutSpy).toHaveBeenCalledTimes(3);
    expect(timeoutSpy.mock.calls.map(([timeout]) => timeout)).toEqual([
      2_500,
      2_500,
      2_500,
    ]);
  });

  it("passes the remaining time to both issue page fetchers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
    const deadline = Date.now() + 1_500;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          team: {
            issues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchOpenTasksPage("cycle-1", ["todo", "progress"], null, deadline);
    await fetchAllTasksPage(null, deadline);

    expect(timeoutSpy.mock.calls.map(([timeout]) => timeout)).toEqual([
      1_500,
      1_500,
    ]);
  });

  it("recomputes remaining time for every history page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
    const deadline = Date.now() + 2_500;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        variables: { after?: string | null };
      };
      if (!body.variables.after) {
        const response = jsonResponse({
          data: {
            issue: {
              history: {
                nodes: [{ createdAt: "2026-10-01T12:00:00Z" }],
                pageInfo: { hasNextPage: true, endCursor: "history-page-1" },
              },
            },
          },
        });
        vi.setSystemTime(new Date(Date.now() + 600));
        return response;
      }
      return jsonResponse({
        data: {
          issue: {
            history: {
              nodes: [{ createdAt: "2026-10-02T12:00:00Z" }],
              pageInfo: { hasNextPage: false, endCursor: "history-page-2" },
            },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTaskHistory("issue-1", deadline)).resolves.toHaveLength(2);
    expect(timeoutSpy.mock.calls.map(([timeout]) => timeout)).toEqual([
      2_500,
      1_900,
    ]);
  });

  it("keeps importer pagination unlimited in total when no deadline is passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        variables: { after?: string | null };
      };
      if (!body.variables.after) {
        const response = jsonResponse({
          data: {
            issue: {
              history: {
                nodes: [{ createdAt: "2026-10-01T12:00:00Z" }],
                pageInfo: { hasNextPage: true, endCursor: "history-page-1" },
              },
            },
          },
        });
        vi.setSystemTime(new Date(Date.now() + 12_000));
        return response;
      }
      return jsonResponse({
        data: {
          issue: {
            history: {
              nodes: [{ createdAt: "2026-10-02T12:00:00Z" }],
              pageInfo: { hasNextPage: false, endCursor: "history-page-2" },
            },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTaskHistory("issue-1")).resolves.toHaveLength(2);
    expect(timeoutSpy.mock.calls.map(([timeout]) => timeout)).toEqual([
      10_000,
      10_000,
    ]);
  });
});
