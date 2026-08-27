"use client";

import {
  createContext,
  type FormEvent,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CodexSession,
  CodexSessionTransport,
} from "../transport/index.js";
import { CodexTransportError } from "../transport/index.js";
import { useCodexThread } from "./context.js";

export type CodexSessionController = {
  sessions: CodexSession[];
  activeSession: CodexSession | null;
  loading: boolean;
  mutating: boolean;
  error: Error | null;
  refreshSessions: () => Promise<boolean>;
  createSession: (title?: string) => Promise<boolean>;
  switchSession: (sessionId: string) => Promise<boolean>;
  renameSession: (sessionId: string, title: string) => Promise<boolean>;
  archiveSession: (sessionId: string) => Promise<boolean>;
  unarchiveSession: (sessionId: string) => Promise<boolean>;
  deleteSession: (sessionId: string) => Promise<boolean>;
};

export type CodexSessionProviderProps = PropsWithChildren<{
  transport: CodexSessionTransport;
  initialSessionId?: string | null;
  autoLoad?: boolean;
  autoCreate?: boolean;
  includeArchived?: boolean;
  onError?: (error: Error) => void;
  onSessionChange?: (session: CodexSession | null) => void;
}>;

const CodexSessionContext = createContext<CodexSessionController | null>(null);

export function CodexSessionProvider({
  autoCreate = true,
  autoLoad = true,
  children,
  includeArchived = true,
  initialSessionId = null,
  onError,
  onSessionChange,
  transport,
}: CodexSessionProviderProps) {
  const thread = useCodexThread();
  const [sessions, setSessions] = useState<CodexSession[]>([]);
  const [activeSession, setActiveSession] = useState<CodexSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(false);
  const activeRef = useRef<CodexSession | null>(null);
  const didAutoLoadRef = useRef(false);
  const wasRunningRef = useRef(thread.running);

  useEffect(() => {
    activeRef.current = activeSession;
  }, [activeSession]);

  const reportError = useCallback(
    (value: unknown) => {
      const nextError =
        value instanceof Error ? value : new Error(String(value));
      if (mountedRef.current) setError(nextError);
      onError?.(nextError);
      return nextError;
    },
    [onError],
  );

  const activate = useCallback(
    async (session: CodexSession) => {
      if (thread.running) {
        reportError(
          new CodexTransportError(
            "codex_session_switch_while_running",
            "Stop the active turn before switching sessions",
          ),
        );
        return false;
      }
      const loaded = await thread.loadThread({
        conversationId: session.id,
        threadId: session.threadId,
      });
      if (!loaded || !mountedRef.current) return false;
      setActiveSession(session);
      setError(null);
      onSessionChange?.(session);
      return true;
    },
    [onSessionChange, reportError, thread],
  );

  const createSession = useCallback(
    async (title?: string) => {
      if (thread.running) {
        reportError(
          new CodexTransportError(
            "codex_session_create_while_running",
            "Stop the active turn before creating a session",
          ),
        );
        return false;
      }
      setMutating(true);
      setError(null);
      try {
        const session = await transport.createSession({ title });
        if (!mountedRef.current) return false;
        setSessions((current) =>
          sortSessions([session, ...withoutSession(current, session.id)]),
        );
        return activate(session);
      } catch (value) {
        reportError(value);
        return false;
      } finally {
        if (mountedRef.current) setMutating(false);
      }
    },
    [activate, reportError, thread.running, transport],
  );

  const refreshSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await transport.listSessions({ includeArchived });
      if (!mountedRef.current) return false;
      const nextSessions = sortSessions(page.sessions);
      setSessions(nextSessions);
      const preferred =
        nextSessions.find((session) => session.id === activeRef.current?.id) ??
        nextSessions.find((session) => session.id === initialSessionId) ??
        nextSessions.find((session) => !session.archived) ??
        null;
      if (preferred) return activate(preferred);
      if (autoCreate) return createSession();
      thread.resetThread();
      setActiveSession(null);
      onSessionChange?.(null);
      return true;
    } catch (value) {
      reportError(value);
      return false;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [
    activate,
    autoCreate,
    createSession,
    includeArchived,
    initialSessionId,
    onSessionChange,
    reportError,
    thread,
    transport,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    if (autoLoad && !didAutoLoadRef.current) {
      didAutoLoadRef.current = true;
      void refreshSessions();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [autoLoad, refreshSessions]);

  useEffect(() => {
    const turnCompleted = wasRunningRef.current && !thread.running;
    wasRunningRef.current = thread.running;
    if (!turnCompleted) return;
    void transport
      .listSessions({ includeArchived })
      .then((page) => {
        if (!mountedRef.current) return;
        const nextSessions = sortSessions(page.sessions);
        setSessions(nextSessions);
        const nextActive =
          nextSessions.find(
            (session) => session.id === activeRef.current?.id,
          ) ?? null;
        setActiveSession(nextActive);
        activeRef.current = nextActive;
        onSessionChange?.(nextActive);
      })
      .catch(reportError);
  }, [
    includeArchived,
    onSessionChange,
    reportError,
    thread.running,
    transport,
  ]);

  const switchSession = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((entry) => entry.id === sessionId);
      if (!session || session.archived) return false;
      if (session.id === activeRef.current?.id) return true;
      setLoading(true);
      try {
        return await activate(session);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [activate, sessions],
  );

  const renameSession = useCallback(
    async (sessionId: string, rawTitle: string) => {
      const title = rawTitle.trim();
      if (!title) return false;
      return mutateSession(setMutating, reportError, async () => {
        const session = await transport.renameSession(sessionId, title);
        if (!mountedRef.current) return false;
        setSessions((current) =>
          sortSessions(
            current.map((entry) => (entry.id === sessionId ? session : entry)),
          ),
        );
        if (activeRef.current?.id === sessionId) {
          setActiveSession(session);
          onSessionChange?.(session);
        }
        return true;
      });
    },
    [onSessionChange, reportError, transport],
  );

  const moveAwayFrom = useCallback(
    async (sessionId: string, nextSessions: CodexSession[]) => {
      if (activeRef.current?.id !== sessionId) return true;
      const next = nextSessions.find((entry) => !entry.archived) ?? null;
      if (next) return activate(next);
      thread.resetThread();
      setActiveSession(null);
      onSessionChange?.(null);
      return true;
    },
    [activate, onSessionChange, thread],
  );

  const archiveSession = useCallback(
    async (sessionId: string) =>
      mutateSession(setMutating, reportError, async () => {
        if (thread.running && activeRef.current?.id === sessionId) {
          throw new CodexTransportError(
            "codex_session_archive_while_running",
            "Stop the active turn before archiving its session",
          );
        }
        await transport.archiveSession(sessionId);
        if (!mountedRef.current) return false;
        const nextSessions = sortSessions(
          sessions.map((entry) =>
            entry.id === sessionId ? { ...entry, archived: true } : entry,
          ),
        );
        setSessions(nextSessions);
        return moveAwayFrom(sessionId, nextSessions);
      }),
    [moveAwayFrom, reportError, sessions, thread.running, transport],
  );

  const unarchiveSession = useCallback(
    async (sessionId: string) =>
      mutateSession(setMutating, reportError, async () => {
        const session = await transport.unarchiveSession(sessionId);
        if (!mountedRef.current) return false;
        setSessions((current) =>
          sortSessions(
            current.map((entry) => (entry.id === sessionId ? session : entry)),
          ),
        );
        return true;
      }),
    [reportError, transport],
  );

  const deleteSession = useCallback(
    async (sessionId: string) =>
      mutateSession(setMutating, reportError, async () => {
        if (thread.running && activeRef.current?.id === sessionId) {
          throw new CodexTransportError(
            "codex_session_delete_while_running",
            "Stop the active turn before deleting its session",
          );
        }
        await transport.deleteSession(sessionId);
        if (!mountedRef.current) return false;
        const nextSessions = sessions.filter((entry) => entry.id !== sessionId);
        setSessions(nextSessions);
        const moved = await moveAwayFrom(sessionId, nextSessions);
        if (
          moved &&
          nextSessions.every((entry) => entry.archived) &&
          autoCreate
        ) {
          return createSession();
        }
        return moved;
      }),
    [
      autoCreate,
      createSession,
      moveAwayFrom,
      reportError,
      sessions,
      thread.running,
      transport,
    ],
  );

  const value = useMemo<CodexSessionController>(
    () => ({
      sessions,
      activeSession,
      loading,
      mutating,
      error,
      refreshSessions,
      createSession,
      switchSession,
      renameSession,
      archiveSession,
      unarchiveSession,
      deleteSession,
    }),
    [
      activeSession,
      archiveSession,
      createSession,
      deleteSession,
      error,
      loading,
      mutating,
      refreshSessions,
      renameSession,
      sessions,
      switchSession,
      unarchiveSession,
    ],
  );

  return (
    <CodexSessionContext.Provider value={value}>
      {children}
    </CodexSessionContext.Provider>
  );
}

export function useCodexSessions() {
  const context = useContext(CodexSessionContext);
  if (!context) {
    throw new Error(
      "useCodexSessions must be used inside CodexSessionProvider",
    );
  }
  return context;
}

export type CodexSessionSwitcherProps = {
  className?: string;
  labels?: Partial<CodexSessionLabels>;
  triggerVariant?: "title" | "icon";
};

export type CodexSessionLabels = {
  newSession: string;
  sessions: string;
  archived: string;
  rename: string;
  archive: string;
  restore: string;
  delete: string;
  confirmDelete: string;
  cancel: string;
  empty: string;
  busy: string;
  close: string;
  recent: string;
  moreActions: string;
  save: string;
  deletePrompt: string;
};

const defaultLabels: CodexSessionLabels = {
  newSession: "New session",
  sessions: "Sessions",
  archived: "Archived",
  rename: "Rename",
  archive: "Archive",
  restore: "Restore",
  delete: "Delete",
  confirmDelete: "Delete now",
  cancel: "Cancel",
  empty: "No sessions",
  busy: "Finish or stop the current turn first",
  close: "Close session history",
  recent: "Recent {count} conversations",
  moreActions: "More actions",
  save: "Save",
  deletePrompt: "Delete this conversation permanently?",
};

export function CodexSessionSwitcher({
  className,
  labels: labelOverrides,
  triggerVariant = "title",
}: CodexSessionSwitcherProps) {
  const controller = useCodexSessions();
  const thread = useCodexThread();
  const labels = { ...defaultLabels, ...labelOverrides };
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [actionsId, setActionsId] = useState<string | null>(null);
  const switcherRef = useRef<HTMLDivElement | null>(null);
  const active = controller.sessions.filter((session) => !session.archived);
  const archived = controller.sessions.filter((session) => session.archived);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const closeDrawer = () => {
    setOpen(false);
    setActionsId(null);
    setRenamingId(null);
    setDeleteId(null);
  };

  return (
    <div
      className={["codex-ui-session-switcher", className]
        .filter(Boolean)
        .join(" ")}
      ref={switcherRef}
    >
      <button
        aria-label={triggerVariant === "icon" ? labels.sessions : undefined}
        aria-expanded={open}
        className={`codex-ui-session-trigger is-${triggerVariant}`}
        disabled={controller.loading}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {triggerVariant === "icon" ? (
          <SessionIcon name="menu" />
        ) : (
          <>
            <span className="codex-ui-session-trigger-title">
              {controller.activeSession?.title ?? labels.sessions}
            </span>
            <SessionIcon name="chevron" />
          </>
        )}
      </button>
      {open ? (
        <div className="codex-ui-session-layer">
          <aside
            aria-label={labels.sessions}
            className="codex-ui-session-drawer"
          >
            <header className="codex-ui-session-drawer-header">
              <div className="codex-ui-session-drawer-title">
                <strong>{labels.sessions}</strong>
                <span>
                  {labels.recent.replace("{count}", String(active.length))}
                </span>
              </div>
              <button
                aria-label={labels.close}
                className="codex-ui-session-close"
                onClick={closeDrawer}
                type="button"
              >
                <SessionIcon name="close" />
              </button>
            </header>
            <div className="codex-ui-session-drawer-body">
              <button
                className="codex-ui-session-new"
                disabled={controller.mutating || thread.running}
                onClick={() =>
                  void controller.createSession().then((created) => {
                    if (created) closeDrawer();
                  })
                }
                type="button"
              >
                <SessionIcon name="compose" />
                {labels.newSession}
              </button>
              {thread.running ? (
                <p className="codex-ui-session-notice">{labels.busy}</p>
              ) : null}
              {controller.error ? (
                <p className="codex-ui-session-error" role="alert">
                  {controller.error.message}
                </p>
              ) : null}
              <div className="codex-ui-session-list">
                {active.length ? (
                  active.map((session) => (
                    <SessionRow
                      actionsOpen={actionsId === session.id}
                      active={session.id === controller.activeSession?.id}
                      deletePending={deleteId === session.id}
                      key={session.id}
                      labels={labels}
                      onArchive={() =>
                        void controller.archiveSession(session.id)
                      }
                      onCancelDelete={() => setDeleteId(null)}
                      onConfirmDelete={() =>
                        void controller.deleteSession(session.id)
                      }
                      onDelete={() => setDeleteId(session.id)}
                      onRename={(title) => {
                        setRenamingId(null);
                        setActionsId(null);
                        void controller.renameSession(session.id, title);
                      }}
                      onSelect={() => {
                        void controller
                          .switchSession(session.id)
                          .then((switched) => {
                            if (switched) closeDrawer();
                          });
                      }}
                      onToggleActions={() =>
                        setActionsId((current) =>
                          current === session.id ? null : session.id,
                        )
                      }
                      renaming={renamingId === session.id}
                      session={session}
                      setRenaming={() => {
                        setDeleteId(null);
                        setRenamingId(session.id);
                      }}
                    />
                  ))
                ) : (
                  <p className="codex-ui-session-empty">{labels.empty}</p>
                )}
                {archived.length ? (
                  <>
                    <div className="codex-ui-session-section">
                      {labels.archived}
                    </div>
                    {archived.map((session) => (
                      <SessionRow
                        actionsOpen={actionsId === session.id}
                        active={false}
                        deletePending={deleteId === session.id}
                        key={session.id}
                        labels={labels}
                        onCancelDelete={() => setDeleteId(null)}
                        onConfirmDelete={() =>
                          void controller.deleteSession(session.id)
                        }
                        onDelete={() => setDeleteId(session.id)}
                        onRestore={() =>
                          void controller.unarchiveSession(session.id)
                        }
                        onToggleActions={() =>
                          setActionsId((current) =>
                            current === session.id ? null : session.id,
                          )
                        }
                        session={session}
                      />
                    ))}
                  </>
                ) : null}
              </div>
            </div>
          </aside>
          <button
            aria-label={labels.close}
            className="codex-ui-session-backdrop"
            onClick={closeDrawer}
            type="button"
          />
        </div>
      ) : null}
    </div>
  );
}

type SessionRowProps = {
  session: CodexSession;
  active: boolean;
  actionsOpen: boolean;
  labels: CodexSessionLabels;
  renaming?: boolean;
  deletePending: boolean;
  onSelect?: () => void;
  setRenaming?: () => void;
  onRename?: (title: string) => void;
  onArchive?: () => void;
  onRestore?: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onToggleActions: () => void;
};

function SessionRow(props: SessionRowProps) {
  const [title, setTitle] = useState(props.session.title);
  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    props.onRename?.(title);
  };
  return (
    <div className={`codex-ui-session-row${props.active ? " is-active" : ""}`}>
      {props.renaming ? (
        <form className="codex-ui-session-rename" onSubmit={submitRename}>
          <input
            aria-label={props.labels.rename}
            maxLength={80}
            onChange={(event) => setTitle(event.target.value)}
            value={title}
          />
          <button className="codex-ui-session-save" type="submit">
            {props.labels.save}
          </button>
        </form>
      ) : (
        <div className="codex-ui-session-row-main">
          <button
            className="codex-ui-session-main"
            disabled={!props.onSelect}
            onClick={props.onSelect}
            type="button"
          >
            <SessionIcon name="history" />
            <span className="codex-ui-session-copy">
              <span className="codex-ui-session-title">
                {props.session.title}
              </span>
              <span className="codex-ui-session-preview">
                {formatSessionTime(props.session.updatedAt)}
                {props.session.preview ? ` · ${props.session.preview}` : ""}
              </span>
            </span>
          </button>
          <button
            aria-expanded={props.actionsOpen}
            aria-label={`${props.labels.moreActions}: ${props.session.title}`}
            className="codex-ui-session-more"
            onClick={props.onToggleActions}
            type="button"
          >
            <SessionIcon name="more" />
          </button>
        </div>
      )}
      {props.deletePending ? (
        <div className="codex-ui-session-confirm">
          <span>{props.labels.deletePrompt}</span>
          <div className="codex-ui-session-confirm-actions">
            <button
              className="codex-ui-session-action"
              onClick={props.onCancelDelete}
              type="button"
            >
              {props.labels.cancel}
            </button>
            <button
              className="codex-ui-session-action is-danger"
              onClick={props.onConfirmDelete}
              type="button"
            >
              {props.labels.confirmDelete}
            </button>
          </div>
        </div>
      ) : props.actionsOpen ? (
        <div className="codex-ui-session-actions">
          {props.setRenaming ? (
            <button
              className="codex-ui-session-action"
              onClick={props.setRenaming}
              type="button"
            >
              {props.labels.rename}
            </button>
          ) : null}
          {props.onArchive ? (
            <button
              className="codex-ui-session-action"
              onClick={props.onArchive}
              type="button"
            >
              {props.labels.archive}
            </button>
          ) : null}
          {props.onRestore ? (
            <button
              className="codex-ui-session-action"
              onClick={props.onRestore}
              type="button"
            >
              {props.labels.restore}
            </button>
          ) : null}
          <button
            className="codex-ui-session-action is-danger"
            onClick={props.onDelete}
            type="button"
          >
            {props.labels.delete}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SessionIcon({
  name,
}: {
  name: "chevron" | "close" | "compose" | "history" | "menu" | "more";
}) {
  const paths = {
    chevron: <path d="m7 10 5 5 5-5" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    compose: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />,
    history: <path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5m4-1v5l3 2" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  };
  return (
    <svg
      aria-hidden="true"
      className="codex-ui-session-icon"
      fill="none"
      viewBox="0 0 24 24"
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        {paths[name]}
      </g>
    </svg>
  );
}

async function mutateSession(
  setMutating: (value: boolean) => void,
  reportError: (value: unknown) => Error,
  operation: () => Promise<boolean>,
) {
  setMutating(true);
  try {
    return await operation();
  } catch (value) {
    reportError(value);
    return false;
  } finally {
    setMutating(false);
  }
}

function withoutSession(sessions: CodexSession[], sessionId: string) {
  return sessions.filter((session) => session.id !== sessionId);
}

function sortSessions(sessions: CodexSession[]) {
  return [...sessions].sort((left, right) => {
    if (left.archived !== right.archived) return left.archived ? 1 : -1;
    return right.updatedAt - left.updatedAt;
  });
}

function formatSessionTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
