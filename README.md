# @customer-ai/codex-ui

可复用的 Codex App Server 前端包。它把协议归并、SSE 传输、React 状态和默认 UI 从宿主项目中拆开，企微、后台系统或独立 Web 应用只需要提供接口地址与业务插槽。

## 边界

- `core`：App Server 类型、事件归一、reducer、selectors 与事件回放；不依赖 React 或浏览器 API。
- `transport`：可替换的 `CodexTransport`，内置 HTTP + SSE 实现。
- `react`：Provider、headless hook、线程、turn、消息、过程、审批、Markdown、输入框与完整聊天组件。
- `styles.css`：无 Tailwind 依赖的默认 Codex 风格主题。

包内不包含认证、客户身份、数据库、具体工具策略或环境配置。当前协议类型基于 `codex-cli 0.142.0` 生成的 App Server schema；未知 method 与未知 item 会保留在 state 中，不会因服务端升级而静默丢失。

## 安装

发布到 registry 后：

```bash
pnpm add @customer-ai/codex-ui
```

尚未发布时，可以在本项目执行 `pnpm pack`，再把生成的 tarball 安装到宿主项目。React 和 React DOM 由宿主提供，最低支持 18.2。

## 最小接入

```tsx
import "@customer-ai/codex-ui/styles.css";
import { CodexChat, CodexThreadProvider } from "@customer-ai/codex-ui/react";
import { createFetchSseCodexTransport } from "@customer-ai/codex-ui/transport";

const transport = createFetchSseCodexTransport({
  statusUrl: "/api/codex/status",
  startTurnUrl: "/api/codex/turns",
  // 可按宿主能力继续配置 interruptTurnUrl、loadThreadUrl、
  // approvalUrl 和 serverRequestUrl。
});

export function Assistant() {
  return (
    <CodexThreadProvider transport={transport}>
      <CodexChat />
    </CodexThreadProvider>
  );
}
```

HTTP transport 默认分别限制短请求、建连等待和 SSE 空闲时间；可用
`requestTimeoutMs`、`turnStartTimeoutMs` 与 `streamIdleTimeoutMs` 调整，设为
`0` 可关闭对应限制。这些超时不会限制正常持续产生事件的整轮执行时间。

`CodexProvider` 是 `CodexThreadProvider` 的稳定简写；`CodexThread` 是受控线程视图，适合由宿主自行管理 state 的场景。

Provider 会把宿主侧稳定的 `conversationId` 与 App Server 返回的原生 `threadId` 分开保存：前者跨多轮不变，用于代理层会话映射；后者写入 `state.threadId`，供协议展示与自定义 transport 使用。可用 `initialConversationId` 或 `createConversationId` 指定宿主会话键。

## 多会话

需要让用户主动新建、切换和管理多个 Codex session 时，在 Thread Provider 内再挂载 Session Provider：

```tsx
import {
  CodexChat,
  CodexSessionProvider,
  CodexSessionSwitcher,
  CodexThreadProvider,
} from "@customer-ai/codex-ui/react";
import {
  createFetchCodexSessionTransport,
  createFetchSseCodexTransport,
} from "@customer-ai/codex-ui/transport";

const threadTransport = createFetchSseCodexTransport({
  statusUrl: "/api/codex/status",
  startTurnUrl: "/api/codex/turns",
  loadThreadUrl: (_threadId, sessionId) =>
    `/api/codex/sessions/${encodeURIComponent(sessionId ?? "")}`,
});

const sessionTransport = createFetchCodexSessionTransport({
  sessionsUrl: "/api/codex/sessions",
});

export function Assistant() {
  return (
    <CodexThreadProvider transport={threadTransport}>
      <CodexSessionProvider transport={sessionTransport}>
        <CodexSessionSwitcher />
        <CodexChat />
      </CodexSessionProvider>
    </CodexThreadProvider>
  );
}
```

`CodexSessionSwitcher` 内置新建、切换、重命名、归档、恢复和二次确认删除；当前 turn 运行时会禁止切换破坏上下文。`useCodexSessions()` 可用于宿主自定义会话列表。默认 Fetch transport 约定以下 REST 接口：

- `GET /sessions`、`POST /sessions`
- `GET /sessions/:id`（由 thread transport 的 `loadThreadUrl` 使用）
- `PATCH /sessions/:id`、`DELETE /sessions/:id`
- `POST /sessions/:id/archive`、`POST /sessions/:id/unarchive`

Session API 的认证、租户归属与持久化仍由宿主负责。组件只使用宿主公开的 session ID；原生 `threadId` 不作为访问控制边界。

默认 start-turn 请求是：

```json
{
  "conversation_id": "宿主提供的线程标识",
  "message": "用户消息",
  "protocol_version": 2
}
```

服务端应返回 `text/event-stream`。每个原生 App Server notification 或 server request 使用 `event: app_server_event`，data 为以下 envelope：

```ts
type Envelope = {
  kind: "notification" | "serverRequest";
  method: string;
  params: Record<string, unknown>;
  streamId: string;
  sequence: number;
  receivedAt: number;
  raw: Record<string, unknown>;
  requestId?: string | number;
};
```

每轮必须包含原生 `turn/completed`。代理层额外发送的 `completed` 和 `error` SSE 控制帧也会被正确处理。

## 宿主定制

默认 `CodexMarkdown` 使用流式安全的 Markdown 渲染，原生支持换行、列表、表格、行内代码与代码块。包内 CSS 已覆盖 Streamdown 的结构化 `data-streamdown` 标记，宿主不需要 Tailwind，也不需要添加 Streamdown 的 `@source` 扫描规则。自定义 Markdown 与工具文案：

```tsx
<CodexChat
  thread={{
    renderMarkdown: (text, tone) => <MyMarkdown tone={tone}>{text}</MyMarkdown>,
    getToolPresentation: (item) => {
      if (item.item.type === "mcpToolCall" && item.item.server === "analytics") {
        return { label: "已查询分析平台", detail: item.item.tool };
      }
      return defaultToolPresentation(item);
    },
  }}
/>
```

`renderItem` 可替换任一 `ThreadItem`；`renderImage` 可接入宿主图片组件。默认 UI 只展示 `reasoning.summary`，不会展示原始 reasoning content，但原始内容仍由 core 保留。

Header、空状态和错误状态也都是公共插槽：

```tsx
<CodexChat
  renderHeader={(controller) => (
    <MyHeader
      loading={controller.statusLoading}
      status={controller.runtimeStatus}
    />
  )}
  thread={{
    renderEmpty: ({ labels }) => <MyEmpty title={labels.emptyTitle} />,
    renderError: ({ error, scope }) => (
      <MyError message={error.message} scope={scope} />
    ),
  }}
/>
```

插槽返回 `undefined` 时继续使用默认 UI，返回 `null` 时明确隐藏对应内容。`renderHeader` 会收到完整的 `CodexThreadController`，因此宿主不需要在组件外重复读取 Provider 状态。

## React 公共组件

- `CodexProvider` / `CodexThreadProvider`
- `CodexSessionProvider` / `CodexSessionSwitcher`
- `CodexChat` / `CodexThread` / `CodexTurn`
- `CodexUserMessage` / `CodexAgentMessage`
- `CodexReasoning` / `CodexToolCall` / `CodexPlan`
- `CodexApproval` / `CodexApprovals` / `CodexError`
- `CodexComposer` / `CodexRunStatus` / `CodexMarkdown`

完整组件复用同一套默认渲染路径；使用细粒度组件不会得到另一套样式或协议解释。宿主既可以覆盖单个 `ThreadItem`，也可以只使用 `useCodexThread()` 与 `useCodexSessions()` 自行组织界面。

审批请求在 composer 上方明确显示“等待确认”；处理后会离开 composer，并在对应 turn 的过程区保留紧凑的已允许、已拒绝或已取消状态。这样不会让历史审批永久挤占输入区，也不会丢失决策结果。

非审批类 server request（例如 `requestUserInput` 或 MCP elicitation）由宿主提供对应界面，并通过回调返回 method 对应的 App Server result：

```tsx
<CodexChat
  renderServerRequest={(request, respond) => (
    <MyRequestForm
      method={request.method}
      params={request.params}
      onSubmit={(result) => respond(result)}
    />
  )}
/>
```

审批按钮只为 command/file 及兼容旧协议的审批 method 提供默认 UI。权限授权等具有不同 response schema 的请求会走通用 server-request 插槽，避免发送错误结构。

## Headless 使用

`useCodexThread()` 暴露：

- `state`、`runtimeStatus`、`running`、`threadLoading`、`activeTurnId` 与 `error`
- `sendMessage`、`stop`、`loadThread`、`refreshStatus`
- `respondToApproval`、`respondToServerRequest`

`core` 还导出 `reduceCodexEvent`、`replayCodexEvents`、`selectTurns`、`selectTurnItems`、`selectPendingApprovals` 与完整协议类型，便于非 React 客户端或录制事件回放。

加载历史线程后继续对话时，应同时提供宿主会话键和原生线程 ID：`loadThread({ conversationId, threadId })`。字符串简写 `loadThread(threadId)` 仅适用于两者相同的宿主。

## 主题

宿主可在 `.codex-ui-chat` 或 `.codex-ui-thread` 上覆盖：

```css
.my-codex {
  --codex-ui-bg: #f7f8fa;
  --codex-ui-surface: #fff;
  --codex-ui-text: #263244;
  --codex-ui-muted: #667085;
  --codex-ui-border: #e4e7ec;
  --codex-ui-accent: #246bfd;
  --codex-ui-on-accent: #fff;
  --codex-ui-danger: #b42318;
  --codex-ui-error-bg: #fef3f2;
  --codex-ui-focus: #84adff;
  --codex-ui-focus-ring: rgb(36 107 253 / 12%);
  --codex-ui-placeholder: #667085;
  --codex-ui-disabled-text: #475467;
  --codex-ui-disabled-bg: #e4e7ec;
  --codex-ui-stop-bg: #182230;
  --codex-ui-approval-border: #e4a547;
  --codex-ui-approval-text: #7a2e0e;
  --codex-ui-approval-bg: #fff9eb;
  --codex-ui-approval-code-bg: rgb(255 255 255 / 72%);
  --codex-ui-approval-primary: #b54708;
  --codex-ui-success: #027a48;
  --codex-ui-success-bg: #ecfdf3;
  --codex-ui-radius: 16px;
  --codex-ui-font: ui-sans-serif, system-ui, sans-serif;
  --codex-ui-mono: ui-monospace, monospace;
}
```

代码块与工具详情使用浅色主题、宽度约束和内部滚动，不会在窄侧边栏中生成黑块或撑破容器。

## 开发与分发

```bash
pnpm install
pnpm build
pnpm check-types
pnpm lint
pnpm test
pnpm pack
```

当前仓库是可独立构建和打包的 npm 包，但尚未发布到 registry。正式发布前需要由维护者确定 registry、访问范围、许可证与版本策略。
