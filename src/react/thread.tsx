import {
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type CodexApprovalDecision,
  type CodexApprovalState,
  type CodexItemState,
  type CodexJsonObject,
  type CodexJsonValue,
  type CodexServerRequestState,
  type CodexThreadState,
  type CodexTurnError,
  type CodexTurnPlan,
  type CodexTurnState,
  selectPendingApprovals,
  selectPendingServerRequests,
  selectTurnItems,
  selectTurns,
} from "../core/index.js";
import type { CodexImageInput } from "../transport/index.js";
import { type CodexThreadController, useCodexThread } from "./context.js";
import { CodexMarkdown } from "./markdown.js";
import {
  type CodexMarkdownTone,
  type CodexToolPresentation,
  type CodexUiLabels,
  defaultCodexUiLabels,
  defaultToolPresentation,
  formatDuration,
  getTurnDuration,
} from "./presentation.js";

export type CodexThreadViewProps = {
  state: CodexThreadState;
  now?: number;
  className?: string;
  labels?: Partial<CodexUiLabels>;
  renderMarkdown?: (text: string, tone: CodexMarkdownTone) => ReactNode;
  renderImage?: (source: string, alt: string) => ReactNode;
  renderItem?: (
    item: CodexItemState,
    turn: CodexTurnState,
  ) => ReactNode | undefined;
  renderEmpty?: (context: CodexEmptyRenderContext) => ReactNode | undefined;
  renderError?: (context: CodexErrorRenderContext) => ReactNode | undefined;
  getToolPresentation?: (item: CodexItemState) => CodexToolPresentation | null;
};

export type CodexEmptyRenderContext = {
  state: CodexThreadState;
  labels: CodexUiLabels;
};

export type CodexErrorRenderContext =
  | {
      scope: "thread";
      error: NonNullable<CodexThreadState["lastError"]>;
      state: CodexThreadState;
    }
  | {
      scope: "turn";
      error: CodexTurnError;
      turn: CodexTurnState;
    };

export type CodexTurnProps = {
  turn: CodexTurnState;
  approvals?: CodexApprovalState[];
  now?: number;
  labels?: Partial<CodexUiLabels>;
  renderMarkdown?: NonNullable<CodexThreadViewProps["renderMarkdown"]>;
  renderImage?: NonNullable<CodexThreadViewProps["renderImage"]>;
  renderItem?: CodexThreadViewProps["renderItem"];
  renderError?: CodexThreadViewProps["renderError"];
  getToolPresentation?: (item: CodexItemState) => CodexToolPresentation | null;
};

export function CodexThreadView({
  className,
  getToolPresentation = defaultToolPresentation,
  labels: labelOverrides,
  now = 0,
  renderEmpty,
  renderError,
  renderItem,
  renderImage = defaultImage,
  renderMarkdown = defaultMarkdown,
  state,
}: CodexThreadViewProps) {
  const labels = useLabels(labelOverrides);
  const turns = selectTurns(state);
  const approvalHistory = selectApprovalHistory(state);
  if (turns.length === 0) {
    const customEmpty = renderEmpty?.({ labels, state });
    return (
      <div
        className={joinClassNames("codex-ui-thread codex-ui-empty", className)}
      >
        {customEmpty === undefined ? (
          <>
            <span aria-hidden="true" className="codex-ui-empty-mark">
              ✦
            </span>
            <h2>{labels.emptyTitle}</h2>
            <p>{labels.emptyDescription}</p>
          </>
        ) : (
          customEmpty
        )}
        {state.lastError ? (
          <CodexRenderedError
            context={{ scope: "thread", error: state.lastError, state }}
            renderError={renderError}
          />
        ) : null}
        {approvalHistory.length > 0 ? (
          <CodexApprovalHistory approvals={approvalHistory} labels={labels} />
        ) : null}
      </div>
    );
  }

  return (
    <div className={joinClassNames("codex-ui-thread", className)}>
      {turns.map((turn) => (
        <CodexTurn
          approvals={approvalHistory.filter(
            (approval) => approval.turnId === turn.id,
          )}
          getToolPresentation={getToolPresentation}
          key={turn.id}
          labels={labels}
          now={now}
          renderItem={renderItem}
          renderImage={renderImage}
          renderMarkdown={renderMarkdown}
          renderError={renderError}
          turn={turn}
        />
      ))}
      {approvalHistory.some(
        (approval) =>
          !approval.turnId || state.turnsById[approval.turnId] === undefined,
      ) ? (
        <CodexApprovalHistory
          approvals={approvalHistory.filter(
            (approval) =>
              !approval.turnId ||
              state.turnsById[approval.turnId] === undefined,
          )}
          labels={labels}
        />
      ) : null}
      {state.lastError ? (
        <CodexRenderedError
          context={{ scope: "thread", error: state.lastError, state }}
          renderError={renderError}
        />
      ) : null}
      {state.tokenUsage ? (
        <div className="codex-ui-token-usage">
          {labels.tokenUsage(state.tokenUsage.total.totalTokens)}
        </div>
      ) : null}
    </div>
  );
}

export type CodexComposerProps = {
  className?: string;
  labels?: Partial<CodexUiLabels>;
  disabled?: boolean;
  maxLength?: number;
  maxImages?: number;
  maxImageBytes?: number;
};

type PendingImage = CodexImageInput & {
  id: string;
  name: string;
};

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function CodexComposer({
  className,
  disabled = false,
  labels: labelOverrides,
  maxLength = 20_000,
  maxImages = DEFAULT_MAX_IMAGES,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
}: CodexComposerProps) {
  const { running, sendMessage, stop, threadLoading, transport } =
    useCodexThread();
  const labels = useLabels(labelOverrides);
  const [message, setMessage] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageInputEnabled = transport.capabilities.imageInput === true;
  const canSend =
    (Boolean(message.trim()) || images.length > 0) &&
    !disabled &&
    !running &&
    !threadLoading;

  const addImageFiles = async (files: File[]) => {
    if (!imageInputEnabled || files.length === 0) return;
    setImageError(null);
    const availableSlots = Math.max(0, maxImages - images.length);
    if (files.length > availableSlots) {
      setImageError(labels.imageLimitReached(maxImages));
    }
    const pending: PendingImage[] = [];
    for (const [index, file] of files.slice(0, availableSlots).entries()) {
      if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
        setImageError(labels.imageTypeUnsupported(file.name));
        continue;
      }
      if (file.size > maxImageBytes) {
        setImageError(
          labels.imageTooLarge(
            file.name,
            Math.ceil(maxImageBytes / 1024 / 1024),
          ),
        );
        continue;
      }
      try {
        pending.push({
          id: `${Date.now()}-${index}-${file.name}`,
          name: file.name,
          url: await readFileAsDataUrl(file),
          detail: "auto",
        });
      } catch {
        setImageError(labels.imageReadFailed(file.name));
      }
    }
    if (pending.length > 0) {
      setImages((current) => [...current, ...pending].slice(0, maxImages));
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    const submitted = message;
    const submittedImages = images;
    setMessage("");
    setImages([]);
    setImageError(null);
    try {
      const sent = await sendMessage(submitted, submittedImages);
      if (!sent) {
        setMessage(submitted);
        setImages(submittedImages);
      }
    } catch {
      setMessage(submitted);
      setImages(submittedImages);
    }
  };

  const onImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void addImageFiles(files);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    event.preventDefault();
    void addImageFiles(files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className={joinClassNames(
        "codex-ui-composer",
        images.length > 0 ? "has-images" : undefined,
        className,
      )}
      onSubmit={(event) => void submit(event)}
    >
      {imageInputEnabled ? (
        <input
          accept="image/jpeg,image/png,image/webp"
          className="codex-ui-image-input"
          multiple
          onChange={onImageChange}
          ref={imageInput}
          type="file"
        />
      ) : null}
      {images.length > 0 ? (
        <div className="codex-ui-pending-images">
          {images.map((image) => (
            <div className="codex-ui-pending-image" key={image.id}>
              <img alt={image.name} src={image.url} />
              <button
                aria-label={labels.removeImage(image.name)}
                className="codex-ui-remove-image"
                disabled={running || threadLoading}
                onClick={() =>
                  setImages((current) =>
                    current.filter((candidate) => candidate.id !== image.id),
                  )
                }
                type="button"
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {imageError ? (
        <div className="codex-ui-image-error" role="alert">
          {imageError}
        </div>
      ) : null}
      <div className="codex-ui-composer-row">
        {imageInputEnabled ? (
          <button
            aria-label={labels.attachImages}
            className="codex-ui-attach-image"
            disabled={
              disabled || running || threadLoading || images.length >= maxImages
            }
            onClick={() => imageInput.current?.click()}
            type="button"
          >
            <ImageIcon />
          </button>
        ) : null}
        <textarea
          aria-label={labels.composerPlaceholder}
          disabled={disabled || running || threadLoading}
          maxLength={maxLength}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={labels.composerPlaceholder}
          rows={1}
          value={message}
        />
        {running ? (
          <button
            aria-label={labels.stop}
            className="codex-ui-composer-action codex-ui-stop"
            onClick={() => void stop()}
            type="button"
          >
            <span aria-hidden="true" />
          </button>
        ) : (
          <button
            aria-label={labels.send}
            className="codex-ui-composer-action codex-ui-send"
            disabled={!canSend}
            type="submit"
          >
            <ArrowIcon />
          </button>
        )}
      </div>
    </form>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("codex_image_read_failed"));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("codex_image_read_failed"));
    reader.readAsDataURL(file);
  });
}

export function CodexApprovals({
  labels: labelOverrides,
  renderServerRequest,
}: {
  labels?: Partial<CodexUiLabels>;
  renderServerRequest?: (
    request: CodexServerRequestState,
    respond: (result: CodexJsonValue) => Promise<boolean>,
  ) => ReactNode | undefined;
}) {
  const { respondToApproval, respondToServerRequest, state, transport } =
    useCodexThread();
  const labels = useLabels(labelOverrides);
  const approvals = selectPendingApprovals(state);
  const approvalIds = new Set(
    approvals.map((entry) => String(entry.requestId)),
  );
  const otherRequests = selectPendingServerRequests(state).filter(
    (entry) => !approvalIds.has(String(entry.requestId)),
  );
  if (approvals.length === 0 && otherRequests.length === 0) return null;
  return (
    <div className="codex-ui-approvals">
      {approvals.map((approval) => (
        <CodexApproval
          approval={approval}
          enabled={transport.capabilities.approvals}
          itemState={findApprovalItem(state, approval)}
          key={String(approval.requestId)}
          labels={labels}
          onDecision={(decision) =>
            respondToApproval(approval.requestId, decision)
          }
        />
      ))}
      {otherRequests.map((request) => {
        const custom = renderServerRequest?.(request, (result) =>
          respondToServerRequest(request.requestId, result),
        );
        return custom !== undefined ? (
          <div key={String(request.requestId)}>{custom}</div>
        ) : (
          <section
            className="codex-ui-approval-card codex-ui-request-pending"
            key={String(request.requestId)}
          >
            <strong>{labels.approvalTitle}</strong>
            <p>{labels.serverRequestPending(request.method)}</p>
          </section>
        );
      })}
    </div>
  );
}

export type CodexChatProps = {
  className?: string;
  composer?: Omit<CodexComposerProps, "className">;
  renderHeader?: (controller: CodexThreadController) => ReactNode | undefined;
  renderServerRequest?: (
    request: CodexServerRequestState,
    respond: (result: CodexJsonValue) => Promise<boolean>,
  ) => ReactNode | undefined;
  thread?: Omit<CodexThreadViewProps, "state" | "className">;
};

export function CodexChat({
  className,
  composer,
  renderHeader,
  renderServerRequest,
  thread,
}: CodexChatProps) {
  const controller = useCodexThread();
  const { running, state } = controller;
  const header = renderHeader?.(controller);
  const [clock, setClock] = useState(0);
  const scrollRegion = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const observedScrollHeight = useRef(0);
  useEffect(() => {
    if (!running) return;
    followOutput.current = true;
    setClock(Date.now());
    const timer = globalThis.setInterval(() => setClock(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    const region = scrollRegion.current;
    const content = region?.firstElementChild;
    if (!region || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followOutput.current) region.scrollTop = region.scrollHeight;
      observedScrollHeight.current = region.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const region = scrollRegion.current;
    if (!region) return;
    if (followOutput.current) region.scrollTop = region.scrollHeight;
    observedScrollHeight.current = region.scrollHeight;
  });

  return (
    <section className={joinClassNames("codex-ui-chat", className)}>
      {header === undefined || header === null ? null : (
        <div className="codex-ui-header-slot">{header}</div>
      )}
      <div
        aria-busy={running}
        aria-live="polite"
        aria-relevant="additions text"
        className="codex-ui-scroll-region"
        onScroll={(event) => {
          const region = event.currentTarget;
          if (
            followOutput.current &&
            region.scrollHeight > observedScrollHeight.current
          ) {
            return;
          }
          followOutput.current =
            region.scrollHeight - region.scrollTop - region.clientHeight < 48;
          observedScrollHeight.current = region.scrollHeight;
        }}
        ref={scrollRegion}
        role="log"
      >
        <CodexThreadView {...thread} now={clock} state={state} />
      </div>
      <div className="codex-ui-chat-footer">
        <CodexApprovals
          labels={composer?.labels}
          renderServerRequest={renderServerRequest}
        />
        <CodexComposer {...composer} />
      </div>
    </section>
  );
}

export function CodexTurn({
  approvals = [],
  getToolPresentation = defaultToolPresentation,
  labels: labelOverrides,
  now = 0,
  renderError,
  renderItem,
  renderImage = defaultImage,
  renderMarkdown = defaultMarkdown,
  turn,
}: CodexTurnProps) {
  const labels = useLabels(labelOverrides);
  const items = selectTurnItems(turn);
  const users = items.filter((entry) => entry.item.type === "userMessage");
  const finals = items.filter(
    (entry) =>
      entry.item.type === "agentMessage" && entry.item.phase !== "commentary",
  );
  const process = items.filter(
    (entry) => !users.includes(entry) && !finals.includes(entry),
  );
  const hasProcess =
    process.length > 0 || Boolean(turn.plan) || Boolean(turn.diff);

  return (
    <article className="codex-ui-turn" data-status={turn.status}>
      {users.map((entry) => (
        <CodexUserMessage
          itemState={entry}
          key={entry.id}
          renderImage={renderImage}
          renderItem={renderItem}
          renderMarkdown={renderMarkdown}
          turn={turn}
        />
      ))}
      <details className="codex-ui-process" open={turn.status === "inProgress"}>
        <summary>
          <CodexRunStatus labels={labels} now={now} turn={turn} />
        </summary>
        {hasProcess || turn.status === "inProgress" ? (
          <div className="codex-ui-process-items">
            {turn.plan ? <CodexPlan labels={labels} plan={turn.plan} /> : null}
            {process.map((entry) => (
              <CodexProcessItem
                getToolPresentation={getToolPresentation}
                itemState={entry}
                key={entry.id}
                labels={labels}
                renderItem={renderItem}
                renderImage={renderImage}
                renderMarkdown={renderMarkdown}
                turn={turn}
              />
            ))}
            {turn.diff ? (
              <ToolDetails label={labels.changes} text={turn.diff} />
            ) : null}
            {turn.status === "inProgress" && process.length === 0 ? (
              <div className="codex-ui-process-row codex-ui-muted">
                <Spinner />
                <span>{labels.starting}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </details>
      {approvals.length > 0 ? (
        <CodexApprovalHistory approvals={approvals} labels={labels} />
      ) : null}
      <div className="codex-ui-final-answer">
        {finals.map((entry) => (
          <CodexAgentMessage
            itemState={entry}
            key={entry.id}
            labels={labels}
            renderItem={renderItem}
            renderMarkdown={renderMarkdown}
            tone="answer"
            turn={turn}
          />
        ))}
      </div>
      {turn.error ? (
        <CodexRenderedError
          context={{ scope: "turn", error: turn.error, turn }}
          renderError={renderError}
        />
      ) : null}
    </article>
  );
}

export type CodexRunStatusProps = {
  turn: CodexTurnState;
  now?: number;
  labels?: Partial<CodexUiLabels>;
};

export function CodexRunStatus({
  labels: labelOverrides,
  now = 0,
  turn,
}: CodexRunStatusProps) {
  const labels = useLabels(labelOverrides);
  const duration = formatDuration(getTurnDuration(turn, now));
  const statusLabel =
    turn.status === "inProgress"
      ? labels.working(duration)
      : turn.status === "completed"
        ? labels.completed(duration)
        : turn.status === "interrupted"
          ? labels.interrupted(duration)
          : labels.failed(duration);
  return (
    <span className="codex-ui-run-status">
      <span className="codex-ui-run-status-label">{statusLabel}</span>
      {turn.status === "inProgress" ? <Spinner /> : <ChevronIcon />}
    </span>
  );
}

export type CodexPlanProps = {
  plan: CodexTurnPlan;
  labels?: Partial<CodexUiLabels>;
};

export function CodexPlan({ labels: labelOverrides, plan }: CodexPlanProps) {
  const labels = useLabels(labelOverrides);
  return (
    <section className="codex-ui-plan">
      <strong>{labels.plan}</strong>
      {plan.explanation ? <p>{plan.explanation}</p> : null}
      <ol>
        {plan.steps.map((step, index) => (
          <li data-status={step.status} key={`${step.step}:${index}`}>
            <span aria-hidden="true" className="codex-ui-plan-dot" />
            {step.step}
          </li>
        ))}
      </ol>
    </section>
  );
}

export type CodexUserMessageProps = {
  itemState: CodexItemState;
  turn: CodexTurnState;
  renderMarkdown?: NonNullable<CodexThreadViewProps["renderMarkdown"]>;
  renderImage?: NonNullable<CodexThreadViewProps["renderImage"]>;
  renderItem?: CodexThreadViewProps["renderItem"];
};

export function CodexUserMessage({
  itemState,
  renderImage = defaultImage,
  renderItem,
  renderMarkdown = defaultMarkdown,
  turn,
}: CodexUserMessageProps) {
  if (itemState.item.type !== "userMessage") return null;
  const custom = renderItem?.(itemState, turn);
  const content = renderUserContent(
    itemState.item,
    renderImage,
    renderMarkdown,
  );
  if (custom === undefined && !content) return null;
  return (
    <div className="codex-ui-user-message">
      {custom !== undefined ? custom : content}
    </div>
  );
}

export type CodexAgentMessageProps = {
  itemState: CodexItemState;
  turn: CodexTurnState;
  tone?: "commentary" | "answer";
  labels?: Partial<CodexUiLabels>;
  renderMarkdown?: NonNullable<CodexThreadViewProps["renderMarkdown"]>;
  renderItem?: CodexThreadViewProps["renderItem"];
};

export function CodexAgentMessage({
  itemState,
  labels: labelOverrides,
  renderItem,
  renderMarkdown = defaultMarkdown,
  tone = "answer",
  turn,
}: CodexAgentMessageProps) {
  const labels = useLabels(labelOverrides);
  if (itemState.item.type !== "agentMessage") return null;
  const custom = renderItem?.(itemState, turn);
  const item = itemState.item;
  if (custom === undefined && !item.text) return null;
  return (
    <div
      className={
        tone === "commentary"
          ? "codex-ui-agent-message codex-ui-commentary"
          : "codex-ui-agent-message codex-ui-agent-answer"
      }
    >
      {custom !== undefined ? custom : renderMarkdown(item.text, tone)}
      {custom === undefined ? (
        <MemoryCitations item={item} label={labels.citations} />
      ) : null}
    </div>
  );
}

export type CodexReasoningProps = {
  itemState: CodexItemState;
  renderMarkdown?: NonNullable<CodexThreadViewProps["renderMarkdown"]>;
};

export function CodexReasoning({
  itemState,
  renderMarkdown = defaultMarkdown,
}: CodexReasoningProps) {
  const item = itemState.item;
  if (item.type !== "reasoning") return null;
  return (
    <div className="codex-ui-reasoning">
      {item.summary.filter(Boolean).map((summary, index) => (
        <div className="codex-ui-process-row" key={`${item.id}:${index}`}>
          <ReasoningIcon />
          {renderMarkdown(summary, "reasoning")}
        </div>
      ))}
    </div>
  );
}

export type CodexToolCallProps = {
  itemState: CodexItemState;
  labels?: Partial<CodexUiLabels>;
  renderImage?: NonNullable<CodexThreadViewProps["renderImage"]>;
  getToolPresentation?: (item: CodexItemState) => CodexToolPresentation | null;
};

export function CodexToolCall({
  getToolPresentation = defaultToolPresentation,
  itemState,
  labels: labelOverrides,
  renderImage = defaultImage,
}: CodexToolCallProps) {
  const labels = useLabels(labelOverrides);
  const presentation = getToolPresentation(itemState);
  if (!presentation) return null;
  const item = itemState.item;
  const itemError = getItemError(itemState);
  const itemDetails = getItemDetails(itemState);
  const isMcpToolCall = item.type === "mcpToolCall";
  return (
    <div className="codex-ui-process-row codex-ui-tool-row">
      {itemState.lifecycle === "started" ? (
        <Spinner />
      ) : (
        <ToolIcon isMcpToolCall={isMcpToolCall} />
      )}
      <div>
        <div
          className={joinClassNames(
            "codex-ui-tool-heading",
            isMcpToolCall ? "is-inline" : undefined,
          )}
        >
          <span>{presentation.label}</span>
          {presentation.detail ? (
            isMcpToolCall ? (
              <code className="codex-ui-tool-inline-detail">
                {presentation.detail}
              </code>
            ) : (
              <small>{presentation.detail}</small>
            )
          ) : null}
        </div>
        {itemState.progress.map((progress, index) => (
          <small key={`${itemState.id}:progress:${index}`}>{progress}</small>
        ))}
        {itemError ? (
          <div className="codex-ui-tool-error">{itemError}</div>
        ) : null}
        {itemDetails ? (
          <ToolDetails label={labels.details} text={itemDetails} />
        ) : null}
        {item.type === "imageGeneration" &&
        isRenderableImageSource(item.result) ? (
          <div className="codex-ui-generated-image">
            {renderImage(item.result, item.revisedPrompt ?? "Generated image")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export type CodexErrorProps = {
  message: string;
  className?: string;
};

export function CodexError({ className, message }: CodexErrorProps) {
  return (
    <div className={joinClassNames("codex-ui-error", className)} role="alert">
      {message}
    </div>
  );
}

function CodexRenderedError({
  context,
  renderError,
}: {
  context: CodexErrorRenderContext;
  renderError: CodexThreadViewProps["renderError"];
}) {
  const custom = renderError?.(context);
  return custom === undefined ? (
    <CodexError message={context.error.message} />
  ) : (
    custom
  );
}

function CodexProcessItem({
  getToolPresentation,
  itemState,
  labels,
  renderItem,
  renderImage,
  renderMarkdown,
  turn,
}: {
  getToolPresentation: (item: CodexItemState) => CodexToolPresentation | null;
  itemState: CodexItemState;
  labels: CodexUiLabels;
  renderItem?: CodexThreadViewProps["renderItem"];
  renderImage: NonNullable<CodexThreadViewProps["renderImage"]>;
  renderMarkdown: NonNullable<CodexThreadViewProps["renderMarkdown"]>;
  turn: CodexTurnState;
}) {
  const custom = renderItem?.(itemState, turn);
  if (custom !== undefined) return custom;
  const item = itemState.item;
  if (item.type === "agentMessage") {
    return (
      <CodexAgentMessage
        itemState={itemState}
        labels={labels}
        renderMarkdown={renderMarkdown}
        tone="commentary"
        turn={turn}
      />
    );
  }
  if (item.type === "hookPrompt") {
    return (
      <div className="codex-ui-hook-prompt">
        <strong>{labels.hookPrompt}</strong>
        {item.fragments.map((fragment) => (
          <div key={fragment.hookRunId}>
            {renderMarkdown(fragment.text, "commentary")}
          </div>
        ))}
      </div>
    );
  }
  if (item.type === "reasoning") {
    return (
      <CodexReasoning itemState={itemState} renderMarkdown={renderMarkdown} />
    );
  }
  if (item.type === "plan") {
    return item.text ? (
      <div className="codex-ui-process-row">
        <ReasoningIcon />
        {renderMarkdown(item.text, "commentary")}
      </div>
    ) : null;
  }

  return (
    <CodexToolCall
      getToolPresentation={getToolPresentation}
      itemState={itemState}
      labels={labels}
      renderImage={renderImage}
    />
  );
}

function ToolDetails({ label, text }: { label: string; text: string }) {
  return (
    <details className="codex-ui-tool-details">
      <summary>{label}</summary>
      <pre>{text}</pre>
    </details>
  );
}

function getItemError(itemState: CodexItemState) {
  const item = itemState.item;
  if (item.type === "mcpToolCall") return item.error?.message ?? null;
  if (item.type === "commandExecution" && item.status === "failed") {
    return item.exitCode === null
      ? "Command failed"
      : `Command failed (${item.exitCode})`;
  }
  if (item.type === "fileChange" && item.status === "failed")
    return "File change failed";
  if (item.type === "dynamicToolCall" && item.status === "failed") {
    return "Tool call failed";
  }
  return null;
}

function getItemDetails(itemState: CodexItemState) {
  const item = itemState.item;
  switch (item.type) {
    case "commandExecution":
      return item.aggregatedOutput || item.command || null;
    case "fileChange":
      return item.changes
        .map((change) => `${change.path}\n${change.diff}`)
        .filter(Boolean)
        .join("\n\n");
    case "mcpToolCall":
      return stringifyDetails({
        arguments: item.arguments,
        result: item.result,
        durationMs: item.durationMs,
      });
    case "dynamicToolCall":
      return stringifyDetails({
        arguments: item.arguments,
        contentItems: item.contentItems,
        success: item.success,
        durationMs: item.durationMs,
      });
    case "collabAgentToolCall":
      return stringifyDetails({
        receivers: item.receiverThreadIds,
        prompt: item.prompt,
        agents: item.agentsStates,
      });
    case "webSearch":
      return item.action ? stringifyDetails(item.action) : item.query;
    case "imageGeneration":
      return stringifyDetails({
        revisedPrompt: item.revisedPrompt,
        result: item.result,
        savedPath: item.savedPath,
      });
    case "enteredReviewMode":
    case "exitedReviewMode":
      return item.review;
    case "unknown":
      return stringifyDetails(item.raw);
    default:
      return null;
  }
}

function stringifyDetails(value: unknown) {
  try {
    return truncateDetails(JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    return truncateDetails(String(value));
  }
}

function truncateDetails(value: string) {
  const limit = 12_000;
  return value.length > limit
    ? `${value.slice(0, limit)}\n… (${value.length - limit} more characters)`
    : value;
}

function renderUserContent(
  item: CodexItemState["item"],
  renderImage: NonNullable<CodexThreadViewProps["renderImage"]>,
  renderMarkdown: NonNullable<CodexThreadViewProps["renderMarkdown"]>,
) {
  if (item.type !== "userMessage") return null;
  const keyCounts = new Map<string, number>();
  const content = item.content.flatMap((part) => {
    const baseKey = userContentKey(part);
    const occurrence = keyCounts.get(baseKey) ?? 0;
    keyCounts.set(baseKey, occurrence + 1);
    const key = `${baseKey}:${occurrence}`;
    switch (part.type) {
      case "text":
        return part.text
          ? [<div key={key}>{renderMarkdown(part.text, "answer")}</div>]
          : [];
      case "image":
        return [
          <div className="codex-ui-user-image" key={key}>
            {renderImage(part.url, "User image")}
          </div>,
        ];
      case "localImage":
        return [<span key={key}>[Image] {part.path}</span>];
      case "skill":
        return [<span key={key}>${part.name}</span>];
      case "mention":
        return [<span key={key}>@{part.name}</span>];
      default:
        return [];
    }
  });
  return content.length > 0 ? content : null;
}

function userContentKey(
  part: Extract<
    CodexItemState["item"],
    { type: "userMessage" }
  >["content"][number],
) {
  switch (part.type) {
    case "text":
      return `text:${part.text}`;
    case "image":
      return `image:${part.url}`;
    case "localImage":
      return `local-image:${part.path}`;
    case "skill":
      return `skill:${part.name}:${part.path}`;
    case "mention":
      return `mention:${part.name}:${part.path}`;
  }
}

function isRenderableImageSource(value: string) {
  return (
    value.startsWith("data:image/") ||
    value.startsWith("blob:") ||
    value.startsWith("https://") ||
    value.startsWith("http://")
  );
}

function defaultImage(source: string, alt: string) {
  return <img alt={alt} loading="lazy" src={source} />;
}

function MemoryCitations({
  item,
  label,
}: {
  item: Extract<CodexItemState["item"], { type: "agentMessage" }>;
  label: string;
}) {
  const citation = item.memoryCitation;
  if (!citation || citation.entries.length === 0) return null;
  return (
    <details className="codex-ui-memory-citations">
      <summary>{label}</summary>
      <ul>
        {citation.entries.map((entry, index) => (
          <li key={`${entry.path}:${entry.lineStart}:${index}`}>
            <code>{entry.path}</code>
            <span>
              {entry.lineStart === entry.lineEnd
                ? `:${entry.lineStart}`
                : `:${entry.lineStart}-${entry.lineEnd}`}
              {entry.note ? ` · ${entry.note}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export type CodexApprovalProps = {
  approval: CodexApprovalState;
  enabled: boolean;
  itemState?: CodexItemState;
  labels?: Partial<CodexUiLabels>;
  onDecision: (decision: CodexApprovalDecision) => Promise<boolean>;
};

export function CodexApproval({
  approval,
  enabled,
  itemState,
  labels: labelOverrides,
  onDecision,
}: CodexApprovalProps) {
  const labels = useLabels(labelOverrides);
  const [resolving, setResolving] = useState(false);
  const [failed, setFailed] = useState(false);
  const contextDetails = getApprovalContextDetails(approval, itemState, labels);
  const decide = async (decision: CodexApprovalDecision) => {
    if (!enabled || resolving) return;
    setResolving(true);
    setFailed(false);
    const resolved = await onDecision(decision);
    if (!resolved) {
      setFailed(true);
      setResolving(false);
    }
  };
  return (
    <section
      aria-busy={resolving}
      className="codex-ui-approval-card"
      data-status="pending"
    >
      <div className="codex-ui-approval-status">
        <span aria-hidden="true" className="codex-ui-approval-status-mark" />
        {labels.approvalWaiting}
      </div>
      <strong>{labels.approvalTitle}</strong>
      <p>{approval.reason || approval.method}</p>
      {contextDetails.length > 0 ? (
        <dl className="codex-ui-approval-details">
          {contextDetails.map((detail) => (
            <div className="codex-ui-approval-detail" key={detail.label}>
              <dt>{detail.label}</dt>
              <dd>
                <code>{detail.value}</code>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {!enabled ? <p>{labels.approvalUnavailable}</p> : null}
      {failed ? (
        <p className="codex-ui-approval-error" role="alert">
          {labels.approvalFailed}
        </p>
      ) : null}
      {enabled ? (
        <div className="codex-ui-approval-actions">
          {approval.availableDecisions.map((decision, index) => {
            const presentation = approvalDecisionPresentation(decision, labels);
            return (
              <button
                className="codex-ui-approval-action"
                data-primary={presentation.primary || undefined}
                disabled={resolving}
                key={`${approvalDecisionKey(decision)}:${index}`}
                onClick={() => void decide(decision)}
                type="button"
              >
                {presentation.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function findApprovalItem(
  state: CodexThreadState,
  approval: CodexApprovalState,
) {
  if (!approval.turnId || !approval.itemId) return undefined;
  return state.turnsById[approval.turnId]?.itemsById[approval.itemId];
}

function selectApprovalHistory(state: CodexThreadState) {
  return Object.values(state.approvalsById)
    .filter((approval) => approval.status !== "pending")
    .sort((left, right) => {
      const leftTime = left.resolvedAt ?? left.startedAtMs ?? 0;
      const rightTime = right.resolvedAt ?? right.startedAtMs ?? 0;
      return leftTime - rightTime;
    });
}

function CodexApprovalHistory({
  approvals,
  labels,
}: {
  approvals: CodexApprovalState[];
  labels: CodexUiLabels;
}) {
  return (
    <div className="codex-ui-approval-history">
      {approvals.map((approval) => {
        const presentation = approvalStatusPresentation(approval, labels);
        return (
          <div
            className="codex-ui-approval-history-row"
            data-status={presentation.status}
            key={String(approval.requestId)}
          >
            <span
              aria-hidden="true"
              className="codex-ui-approval-status-mark"
            />
            <span className="codex-ui-approval-history-label">
              {presentation.label}
            </span>
            <span className="codex-ui-approval-history-detail">
              {approval.reason || approval.method}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function approvalStatusPresentation(
  approval: CodexApprovalState,
  labels: CodexUiLabels,
) {
  if (approval.status === "failed") {
    return { label: labels.approvalCanceled, status: "canceled" as const };
  }
  if (approval.decision === "decline") {
    return { label: labels.approvalRejected, status: "rejected" as const };
  }
  if (approval.decision === "cancel") {
    return { label: labels.approvalCanceled, status: "canceled" as const };
  }
  if (
    approval.decision &&
    typeof approval.decision === "object" &&
    "applyNetworkPolicyAmendment" in approval.decision &&
    approval.decision.applyNetworkPolicyAmendment.network_policy_amendment
      .action === "deny"
  ) {
    return { label: labels.approvalRejected, status: "rejected" as const };
  }
  if (approval.decision) {
    return { label: labels.approvalAccepted, status: "accepted" as const };
  }
  return { label: labels.approvalResolved, status: "resolved" as const };
}

function getApprovalContextDetails(
  approval: CodexApprovalState,
  itemState: CodexItemState | undefined,
  labels: CodexUiLabels,
) {
  const params = approval.params;
  const command =
    stringValue(params.command) ??
    stringArray(params.command)?.join(" ") ??
    commandActionsValue(params.commandActions);
  const cwd = stringValue(params.cwd);
  const networkContext = objectValue(params.networkApprovalContext);
  const networkHost =
    stringValue(networkContext?.host) ?? proposedNetworkHost(params);
  const fileChanges = objectValue(params.fileChanges);
  const files = new Set(fileChanges ? Object.keys(fileChanges) : []);
  if (itemState?.item.type === "fileChange") {
    for (const change of itemState.item.changes) files.add(change.path);
  }
  const grantRoot = stringValue(params.grantRoot);
  return [
    command
      ? { label: labels.approvalCommand, value: truncateApprovalValue(command) }
      : null,
    cwd
      ? {
          label: labels.approvalWorkingDirectory,
          value: truncateApprovalValue(cwd),
        }
      : null,
    networkHost
      ? {
          label: labels.approvalNetworkHost,
          value: truncateApprovalValue(networkHost),
        }
      : null,
    files.size > 0
      ? {
          label: labels.approvalFiles,
          value: truncateApprovalValue([...files].join("\n")),
        }
      : null,
    grantRoot
      ? {
          label: labels.approvalWriteRoot,
          value: truncateApprovalValue(grantRoot),
        }
      : null,
  ].filter((detail): detail is { label: string; value: string } =>
    Boolean(detail),
  );
}

function commandActionsValue(value: CodexJsonValue | undefined) {
  if (!Array.isArray(value)) return null;
  const commands = value.flatMap((entry) => {
    const command = stringValue(objectValue(entry)?.command);
    return command ? [command] : [];
  });
  return commands.length > 0 ? commands.join(" && ") : null;
}

function proposedNetworkHost(params: CodexJsonObject) {
  const amendments = params.proposedNetworkPolicyAmendments;
  if (!Array.isArray(amendments)) return null;
  for (const amendment of amendments) {
    const host = stringValue(objectValue(amendment)?.host);
    if (host) return host;
  }
  return null;
}

function objectValue(value: CodexJsonValue | undefined) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function stringValue(value: CodexJsonValue | undefined) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: CodexJsonValue | undefined) {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function truncateApprovalValue(value: string) {
  const limit = 2_000;
  return value.length > limit
    ? `${value.slice(0, limit)}\n… (${value.length - limit} more characters)`
    : value;
}

function approvalDecisionPresentation(
  decision: CodexApprovalDecision,
  labels: CodexUiLabels,
) {
  if (decision === "accept") return { label: labels.approve, primary: true };
  if (decision === "acceptForSession") {
    return { label: labels.approveForSession, primary: true };
  }
  if (decision === "decline") return { label: labels.decline, primary: false };
  if (decision === "cancel") return { label: labels.cancel, primary: false };
  if ("acceptWithExecpolicyAmendment" in decision) {
    return { label: labels.approveWithExecPolicy, primary: true };
  }
  const amendment =
    decision.applyNetworkPolicyAmendment.network_policy_amendment;
  return {
    label: labels.applyNetworkPolicy(amendment.host, amendment.action),
    primary: amendment.action === "allow",
  };
}

function approvalDecisionKey(decision: CodexApprovalDecision) {
  return typeof decision === "string" ? decision : JSON.stringify(decision);
}

function useLabels(overrides: Partial<CodexUiLabels> | undefined) {
  return useMemo(
    () => ({ ...defaultCodexUiLabels, ...overrides }),
    [overrides],
  );
}

function defaultMarkdown(text: string, tone: CodexMarkdownTone) {
  return <CodexMarkdown tone={tone}>{text}</CodexMarkdown>;
}

function joinClassNames(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

function Spinner() {
  return <span aria-hidden="true" className="codex-ui-spinner" />;
}

function ChevronIcon() {
  return <span aria-hidden="true" className="codex-ui-chevron" />;
}

function ToolIcon({ isMcpToolCall }: { isMcpToolCall: boolean }) {
  return (
    <span aria-hidden="true" className="codex-ui-tool-icon">
      {isMcpToolCall ? (
        <svg className="codex-ui-tool-wrench" fill="none" viewBox="0 0 24 24">
          <title>MCP tool</title>
          <path
            d="M14.7 6.3a4 4 0 0 0-4.7 5.1l-7.4 7.4a2.1 2.1 0 0 0 3 3l7.4-7.4a4 4 0 0 0 5.1-4.7l-2.4 2.4-3-3 2-2.4Z"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </svg>
      ) : (
        "⌁"
      )}
    </span>
  );
}

function ReasoningIcon() {
  return (
    <span aria-hidden="true" className="codex-ui-reasoning-icon">
      ✦
    </span>
  );
}

function ArrowIcon() {
  return <span aria-hidden="true">↑</span>;
}

function ImageIcon() {
  return (
    <svg
      aria-hidden="true"
      className="codex-ui-attach-image-icon"
      fill="none"
      viewBox="0 0 24 24"
    >
      <rect
        height="16"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.8"
        width="18"
        x="3"
        y="4"
      />
      <circle cx="9" cy="10" fill="currentColor" r="1.5" />
      <path
        d="m5.5 17 4.2-4.2 2.8 2.8 2-2 4 3.4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="codex-ui-remove-image-icon"
      fill="none"
      viewBox="0 0 12 12"
    >
      <path
        d="m3 3 6 6M9 3 3 9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}
