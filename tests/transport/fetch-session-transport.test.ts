import { describe, expect, it, vi } from "vitest";
import {
  type CodexTransportError,
  createFetchCodexSessionTransport,
} from "../../src/transport/index.js";

const session = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  thread_id: "thread-1",
  title: "销售分析",
  preview: "查询今天营业额",
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_001_000,
  archived: false,
};

describe("createFetchCodexSessionTransport", () => {
  it("lists and normalizes server sessions", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ sessions: [session], next_cursor: null }),
      );
    const transport = createFetchCodexSessionTransport({
      sessionsUrl: "/api/codex/sessions",
      fetch: fetchMock,
    });

    await expect(
      transport.listSessions({ includeArchived: true }),
    ).resolves.toEqual({
      sessions: [
        {
          id: session.id,
          threadId: "thread-1",
          title: "销售分析",
          preview: "查询今天营业额",
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_001_000,
          archived: false,
          raw: session,
        },
      ],
      nextCursor: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/codex/sessions?include_archived=true",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("uses predictable REST actions for the full lifecycle", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ session }))
      .mockResolvedValueOnce(
        Response.json({ session: { ...session, title: "新标题" } }),
      )
      .mockResolvedValueOnce(Response.json({ status: "archived" }))
      .mockResolvedValueOnce(
        Response.json({ session: { ...session, archived: false } }),
      )
      .mockResolvedValueOnce(Response.json({ status: "deleted" }));
    const transport = createFetchCodexSessionTransport({
      sessionsUrl: "/sessions",
      fetch: fetchMock,
    });

    await transport.createSession({ title: "销售分析" });
    await transport.renameSession(session.id, "新标题");
    await transport.archiveSession(session.id);
    await transport.unarchiveSession(session.id);
    await transport.deleteSession(session.id);

    expect(
      fetchMock.mock.calls.map(([url, init]) => [url, init?.method]),
    ).toEqual([
      ["/sessions", "POST"],
      [`/sessions/${session.id}`, "PATCH"],
      [`/sessions/${session.id}/archive`, "POST"],
      [`/sessions/${session.id}/unarchive`, "POST"],
      [`/sessions/${session.id}`, "DELETE"],
    ]);
  });

  it("surfaces stable transport errors", async () => {
    const transport = createFetchCodexSessionTransport({
      sessionsUrl: "/sessions",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ detail: "failed" }, { status: 500 }),
        ),
    });

    await expect(
      transport.listSessions(),
    ).rejects.toMatchObject<CodexTransportError>({
      code: "codex_session_list_failed",
    });
  });
});
