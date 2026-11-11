# 侧栏会话 · Side chat

在 DSH（DeepSeek Harness）里仿照 Codex 的 `/side`：**选中一段文字，在右侧栏开一个独立的会话讨论它，主会话一个字都不多。**

- 选中文本 → 浮层出现两个胶囊：**引用文本** / **侧栏会话**
- 点「侧栏会话」→ 右侧栏开出一个**空白**会话，输入框里已经放好「父会话引用胶囊 + 选区引用」
- 侧栏里的对话不会出现在主会话的记录里；一条会话**复用一个**侧栏会话
- 关掉页签就结束，不归档、不阻塞，随时可再开

```
┌───────────────────────────────┬──────────────────────┐
│  主会话                        │  侧栏会话（空白）      │
│  你: 整理参数化方法与论文…      │                      │
│  助手: 两阶段策略：先保证双射…  │  ┌────────────────┐  │
│  你: ▓▓选中这段▓▓              │  │ @整理参数化…  ▸ │  │ ← 父会话引用胶囊
│      ┌──────────┬──────────┐  │  │ > 选中的那段文字 │  │ ← 引用
│      │ 引用文本  │ 侧栏会话 │  │  └────────────────┘  │
│      └──────────┴──────────┘  │  你: 这里为什么…       │
└───────────────────────────────┴──────────────────────┘
```

---

## 目录

- [它做了什么](#它做了什么)
- [为什么这样实现（平台约束推导）](#为什么这样实现平台约束推导)
- [架构](#架构)
- [数据流](#数据流)
- [用到的扩展点](#用到的扩展点)
- [上下文是怎么带过去的](#上下文是怎么带过去的)
- [HTTP 协议](#http-协议)
- [安装 / 卸载](#安装--卸载)
- [开发与自测](#开发与自测)
- [已知限制](#已知限制)
- [安全边界](#安全边界)
- [版本演进与踩过的坑](#版本演进与踩过的坑)

---

## 它做了什么

| 交互 | 结果 |
|---|---|
| 在对话里选中文字 | 浮层出现「引用文本」「侧栏会话」两个胶囊（替换掉原生「引用文本」单胶囊，行为不变） |
| 点「侧栏会话」 | Host 创建一个空白会话；右侧栏打开它的页签；输入框预填父会话引用 + 选区引用 |
| 再点一次 | **复用同一条**侧栏会话，不新建 |
| 关闭页签 | 会话留在磁盘（平台无删除 API），但不在任何工作区里 |
| 空会话（还没发过消息） | 拒绝开启，提示“先发一条消息”（与 Codex `/side` 的守卫一致） |

侧栏页签标题固定为「侧栏会话」，地址是 `dsh-resource://sidechat/session/<sessionId>`，像普通页签一样可拖动、可拆分、可浮动。

---

## 为什么这样实现（平台约束推导）

Codex 的 `/side` 是“fork 出临时线程 + 视觉上从边界开始 + 结束后丢弃”。DSH 没有一个能同时满足这三点的原语，几条路都被平台规则堵死，这里是完整的推导：

**1. 不能直接 fork。**
`sessionController.fork()` 会 `workspace.attachSession(childId)`，把子会话挂进父会话所在的工作区，并且 `isSeeded: true` 会把父会话到当前为止的 turn 全部搬进子会话日志 —— 左侧列表多一条、右侧栏重复显示整段历史。

**2. 不能“fork 完就归档”。**
归档不是列表过滤标记，而是硬闸门。`@deepseek-ai/dsh-api-session-controller` 的 `ArchivedSessionGate`：

```js
ctx.on('agent/pre-step', (payload, next) => underArchivedSession(ctx, payload.agent)
  ? Promise.resolve({ kind: 'reject' }) : next());
```

被拒的 turn 以 `reason: 'blocked'` 结束、**一次模型请求都不发**，界面上表现为“已完成，用时 1 秒”而没有任何回复。

**3. 不能靠 `origin: 'subagent'` 隐藏。**
`ui-workspace` 的 `sessionVisible()` 第一行确实会隐藏这类会话（`if (session.origin === 'subagent') return false`），但代价是客户端把它当成**子智能体的子会话**：

- 输入区只读：`const continuable = subagent?.address.mode === 'continuable'` —— 没有真实 activation 的会话 `mode` 永远是 `unknown`，于是提示“此子智能体暂时只读”。
- 附件被拒：`Session.prompt()` 里带地址的会话遇到 file part 直接返回 `SUBAGENT_FILE_UNSUPPORTED`，也就是“当前无法导入文件”。
- 消息根本发不出去：Host 侧 `sessionController.prompt` 对 subagent-origin 会话抛 `session/agent-busy`（“subagent Sessions require their durable parent address”），必须走 `subagents.prompt` + 真实 activation。

**结论**：在这套平台上，“从工作区隐藏”和“当普通会话用”目前是互斥的。

**所以本插件的选择是：可用优先。**
Host 创建一个**普通空白会话**（父会话的 `cwd`、不挂 workspace、部署默认模型），上下文用**会话引用**（session reference）承载 —— 只进模型、不进界面。代价是它出现在左侧“未归组”里，一条会话最多一条，靠复用来限制数量。

---

## 架构

两个半边，一个包：

```
.
├── index.js          Host 半：一条 Fetch 路由，负责“造会话”
├── client.js         Client 半：选区浮层 + 右侧栏页签类型 + 资源供给 + 预填
├── cordis.patch.yml  bundle 补丁：插入 include:side-chat 这一行
├── package.json      dsh.bundle + dsh.client 双面声明
├── locale/{zh,en}.json  插件管理器里的标题/描述
├── icon.svg
├── tools/            自测脚本（见“开发与自测”）
├── LICENSE
└── README.md
```

Host 侧只做一件客户端做不到的事：**用指定的 header 创建会话**（`ctx.agents.create`）。其余全部在浏览器里完成。

```
 选中文本
    │
    ▼
client.js  SelectionActions ──POST /api/side-chat/open──► index.js
    │                                                     ├─ 校验 parentSessionId
    │                                                     ├─ ctx.agents.get(parent)
    │                                                     └─ ctx.agents.create({ meta: { cwd } })
    │◄──────────────── { sessionId } ─────────────────────┘
    │
    ├─ 轮询 sessions.list 等 agent/created 公告到达
    ├─ localStorage['side-chat.v3.side-sessions'][parent] = child
    └─ ctx.sidebarRight.openResource('dsh-resource://sidechat/session/<child>')
           │
           ▼
      资源提供者 open()：sessions.retain(child) → 预填输入框 → 挂起等页签关闭
           │
           ▼
      页签体：SessionProvider(子会话) → renderFactorySlot('conversation.content')
```

---

## 数据流

1. **选区**：`uiConversation.interactions` 里只有 `message-quotes` 会响应 `trigger === 'selection'`，而浮层槽位是单格的 —— 所以本插件接管了 `quote` 这一格（`priority: -100`，keyed 槽位的规则是**数字越低越渲染**），渲染成一排两个胶囊，原名原行为保留引用。
2. **取会话**：POST 到 Host 路由；成功后在 `localStorage` 记下 `父 → 子` 映射，并等待 `agent/created` 转成的 `api-session/added` 让目录认识这个 id（最多等 2 秒），避免 `sessions.retain` 早于目录更新而抛错。
3. **开页签**：`ctx.sidebarRight.openResource(address)`。右侧栏是**按会话分配的**，所以页签挂在当前主会话的右栏里；地址里的会话 id 决定内容。
4. **资源供给**：`ctx.resources.register({ protocol: 'sidechat', open })`。`open()` 里 `sessions.retain`，`await reference.ready`，预填输入框，然后 `await waitForAbort(signal)`；页签关闭 → signal abort → `reference.release()`，一个页签一份引用。
5. **渲染**：页签体声明一个 session 作用域的子席位 `sidechat.seat`（`SessionProvider` 只会发给“声明了非 root 子席位”的注册），然后用 `renderFactorySlot('conversation.content', { variant: 'embedded', … }, { slots: { views } })` 托管宿主自己的会话内容 —— 这是 `ui-subagent` 的聊天页签同款配方。

---

## 用到的扩展点

| 扩展点 | 用途 | 位置 |
|---|---|---|
| `ctx.slots.register('conversation.chat.text-interaction', key: 'quote')` | 选区浮层（两个胶囊） | `client.js` · `SelectionActions` |
| `ctx.uiConversation.interactions` | 借用 Quote 的选区准入（不重复注册，避免抢浮层） | 同上 |
| `ctx.slots.register('sidebar.right.pane.tab', key: '@local/side-chat')` | 右侧栏页签体 | `client.js` · `SideChatTab` |
| `ctx.sidebarRightTabs.register` | 页签类型 `sidechat` + 地址 glob | `client.js` · `apply` |
| `ctx.resources.register({ protocol: 'sidechat' })` | 地址 → 保留会话引用 | `client.js` · `provider` |
| `ctx.sidebarRight.openResource` | 打开/聚焦页签 | `client.js` · `openSideChat` |
| `ctx.conversation.input.shell(id).actions` | 预填输入框（`setDraft` / `insertQuote`） | `client.js` · `prefill` |
| `ctx.connection.fetch.register` | Host 侧的创建会话入口（owner 专用） | `index.js` · `apply` |
| `ctx.agents.create` | 用指定 header 造会话 | `index.js` · `createSideSession` |

---

## 上下文是怎么带过去的

侧栏会话本身是**空白**的（没有 seed），上下文靠一条 **会话引用**（session reference）跟着第一条用户消息走：

```
@[整理参数化方法与论文](dsh-session:InIgc2Vzc2lvbi0...)
```

- 这是 `@deepseek-ai/dsh-session-reference` 的规范 mention 格式：`@[标签](dsh-session:<JSON(sessionId) 的 base64url>)`。
- `agent/pre-step` 里，`dsh-session-reference` 会解析**任意用户消息**里的这种 mention，把被引用会话的快照（按字节上限裁剪）**插在该消息之后**，只在模型请求里出现。
- 界面侧，`ui-conversation` 的 `sessionReferenceRule` 把这种 mention 渲染成一个会话小胶囊，所以聊天记录里看不到 base64 噪音，也不会重复整段历史。

也就是说：**历史只给模型看，界面从空白开始** —— 这正是 Codex 侧栏会话的语义。

---

## HTTP 协议

```
POST /api/side-chat/open
Content-Type: application/json

{ "parentSessionId": "session-..." }
```

| 状态 | 响应 | 含义 |
|---|---|---|
| 200 | `{ "sessionId": "session-..." }` | 已创建（普通会话，`cwd` 取父会话，未挂 workspace） |
| 400 | `{ "error": "parent-session-required" }` | 请求体不合法或超过 4 KiB |
| 409 | `{ "error": "…" }` | 父会话不在世，或创建失败（错误原文透传） |

- 路由注册在 Web carrier 已拥有的共享 `/api` 通道上，精确路由只有 **`peer.principal.kind === 'owner'`** 才会被执行，否则 403；Host/Origin 栅栏与 Cookie/Token 鉴权在路由之前已经完成。
- 请求体上限 4096 字节，只读一个字段。
- 404 会被客户端翻译成“宿主端还没加载新版本，重启一次应用即可”。

---

## 安装 / 卸载

从仓库克隆后按本地目录安装：

```bash
git clone https://github.com/BlakrPander/dsh-side-chat.git
```

然后在 DSH 的插件管理器里把 `install_bundle` 的 `target` 指向克隆下来的目录。

本地目录安装（本插件就是这样装的）：

```bash
# 在 DSH 里用插件管理器安装（推荐）
# plugin_manager: install_bundle → target = 本目录绝对路径
```

等价的手工方式（会写 profile 的 package.json / patch 层，通常不必自己来）：

```bash
dsh plugin --profile desktop add link:/path/to/side-chat
```

启用 / 停用 / 移除：

```
plugin_manager: set_bundle   target=@local/side-chat enabled=false   # 停用
plugin_manager: remove_bundle target=@local/side-chat                # 移除
```

安装为一个 **link** 目录时，改完 `client.js` 刷新页面即可；改完 `index.js` 由 Host HMR 监听 link 目标自动替换。

---

## 开发与自测

```bash
node --check client.js                  # 语法
node --check index.js

# 无头冒烟：选区浮层 → POST → 资源流 → 预填 → 释放。零依赖，只用 Node。
node tools/side-chat-check.mjs

# 在真实 Cordis 上跑一遍 apply()，并模拟平台的两条槽位硬规则。
# 需要一个已解包的 @deepseek-ai/cordis/lib/index.js（DSH 应用包内就有）。
CORDIS_PATH=/path/to/node_modules/@deepseek-ai/cordis/lib/index.js \
  node tools/side-chat-apply.mjs declared
```

`tools/side-chat-apply.mjs` 会模拟平台的两条硬规则：keyed 槽位同 key 同 priority 注册必须抛错、同名子槽位不可二次声明 —— 这两条正是早期两次“插件 failed”的根因，用它们守住回归。

---

## 已知限制

1. **会出现在左侧列表**（未归组）。这是当前平台下“隐藏”与“能对话”互斥的结果，详见上面的推导。可以进一步做成“开页签时取消归档、关页签时归档”，只在用的时候出现。
2. **没有真正的销毁**。平台没有删除会话的 API（`sessionPersistence` 只有 create/open/flush/stat/list），归档又会拦住 turn，所以临时会话只是“不在列表里/不再引用”，日志仍留在磁盘。靠复用把数量压到一条会话一条。
3. **拖拽无法区分主会话与侧栏**。`ui-attachment` 把拖拽监听挂在 `document` 上、每个 composer 各自按 `canAcceptDrop` 接收，没有指针命中测试，也没有“落点高亮”。要做得像 Codex 那样，得改那个宿主插件。
4. **子会话权限走部署默认**，不跟随父会话当前的 permission profile（审批仍走正常审批服务，绕不过）。
5. **遮蔽了原生引用胶囊**：接管 `quote` 槽位是为了放第二个按钮，引用行为逐字保留；停用本插件即恢复原样。
6. 页签标题固定，不跟随会话标题；一条父会话只对应一个侧栏会话（不区分多次 `/side`）。

---

## 安全边界

- Host 半只暴露一条精确路由，仅 owner Principal 可用，4 KiB 上限，只接受一个 `parentSessionId`。
- 能做的事等价于“在 UI 里点新会话”：在父会话的 `cwd` 下、用部署默认模型建一个会话。无凭据读写、无文件系统访问、无命令执行。
- 不修改任何宿主配置、不写 profile 的 `package.json` 或 `cordis.patch.yml`。
- 客户端只在 `localStorage` 里存一份 `父 → 子` 的会话 id 映射（`side-chat.v3.side-sessions`），不含任何内容。

---

## 版本演进与踩过的坑

| 版本 | 做法 | 结果 | 教训 |
|---|---|---|---|
| v1 | 在 `conversation.chat.text-interaction` 注册自己的 key | 插件 `failed`，启动即崩 | keyed 槽位**同 key 同 priority 注册会抛错**；要遮蔽必须换 priority（数字最低者渲染） |
| v1 | 页签体额外声明 `sidebar.chat.conversation` 子槽位 | 抛“slot is already declared” | 子槽位名全局唯一，不能二次声明 |
| v1 | fork + 立即 `archiveSession` | 侧栏能开、能看，但发消息“已完成，1 秒”无回复 | 归档是 `agent/pre-step` 的硬闸门，turn 以 `blocked` 结束 |
| v2 | Host 造 `origin:'subagent'` 会话（隐藏） | 侧栏能开、界面空白，但输入框只读、附件被拒、消息发不出 | 平台的“隐藏”绑死了“委派”：`SUBAGENT_FILE_UNSUPPORTED`、`session/agent-busy` |
| v3 | 普通空白会话 + 会话引用承载上下文 | 可用，落在“未归组” | 可用优先；隐藏留给平台解决 |

其中 v1 的两个槽位错误是靠读 `SlotCore.register()` 的校验代码定位的 —— 报错只有 `@local/side-chat: failed` 一行，`web boot` 审计不打印原因，插件的 `report()` 会把真实栈写进渲染器控制台，桌面端崩溃日志才收得到。

---

## 许可

MIT。
