# AI 编程工作台 · 开发方案

> 文档定位：**设计文档回答「做什么」，本文档回答「怎么做」**
> 上游依据：《AI 编程工作台-设计方案.md》
> 交付形态：单文件 `index.html`（约 2700 行 / 100KB），零依赖、零构建、可离线打开
> 目标读者：执行开发的人（就是你自己）

---

## 1. 技术约束（不可协商）

| # | 约束 | 理由 |
|---|---|---|
| 1 | 单文件 HTML，CSS/JS 全内联 | 用户可能只保存 HTML，外链一失效功能全废 |
| 2 | 零第三方库（框架、图表、图标、字体） | 同上，且避免版本腐化 |
| 3 | 无构建步骤（不用 webpack/vite/tsc） | 双击就能跑，改一行就能看效果 |
| 4 | 图表手写内联 SVG | 需求只有条形图和折线图，引入库不划算 |
| 5 | 图标用内联 `<svg><path>`，禁用 emoji 与图标字体 | emoji 跨系统渲染不一致，暗色主题下显廉价 |
| 6 | 存储用 localStorage，键前缀 `wb_aidev_` | 避免与其他页面冲突 |
| 7 | 纯前端，无后端、无账号 | 一人使用，导出即迁移 |
| 8 | 浏览器目标：Chrome/Edge/Safari 最近两个大版本 | 可用 `?.`、`??`、`structuredClone`、`navigator.clipboard`（需降级） |

**语言选择**：原生 JS（ES2022）+ JSDoc 类型注释，不用 TypeScript。
理由：写 TS 就必须有编译步骤，破坏约束 3；JSDoc 在 VSCode 里有接近 TS 的补全和检查，收益足够。

---

## 2. 代码组织

### 2.1 单文件内的六大分区

文件按固定顺序排列，**顺序即依赖顺序**（下层先定义，上层后调用）。每个分区用醒目注释分隔，便于跳转：

```
index.html
├─ <head>
│   └─ <style>  ── ① 设计令牌  ── ② 基础重置  ── ③ 组件  ── ④ 布局  ── ⑤ 响应式
├─ <body>
│   └─ HTML 骨架（导航、视图容器、浮层、toast 容器）
└─ <script>
    ├─ /* ===== 0. 常量与配置 ===== */
    ├─ /* ===== 1. 数据层 store ===== */        ← 只做读写与迁移，不含业务
    ├─ /* ===== 2. 计算层 selectors ===== */    ← 纯函数，无副作用，可单测
    ├─ /* ===== 3. 渲染层 render ===== */       ← 只读 store，只写 DOM
    ├─ /* ===== 4. 动作层 actions ===== */      ← 改数据，然后调 refreshAll()
    ├─ /* ===== 5. 调度层 ===== */              ← refreshAll / 路由 / 事件委托
    └─ /* ===== 6. 初始化 ===== */              ← DOMContentLoaded
```

### 2.2 分层调用规则（防递归的核心）

```
actions ──► store          （写）
actions ──► refreshAll()   （唯一的刷新入口）
refreshAll ──► selectors   （算）
refreshAll ──► render      （画）
render ──► selectors       （允许：读派生数据）
render ──► store.read      （允许：读原始数据）
render ──► render          （❌ 严禁）
selectors ──► 任何 render  （❌ 严禁）
store ──► 任何上层          （❌ 严禁）
```

**强制检查**：提交前用正则扫一遍，`render` 函数体内不允许出现 `render[` 开头的调用。

```bash
# 自查命令（在浏览器 console 或 grep）
grep -n "function render" -A 60 index.html | grep -E "render[A-Z]\w+\(" 
# 期望输出：仅 refreshAll 内的调用行
```

### 2.3 HTML 骨架约定

视图容器只保留一个，切换视图靠替换 innerHTML，避免多容器 hide/show 的状态残留：

```html
<aside id="nav"><!-- 侧栏，PC 显示；移动端隐藏，改用底部 tab --></aside>
<main id="view"><!-- 所有视图渲染到这里 --></main>
<div id="overlay"><!-- 快速捕获 / 搜索浮层 / 确认弹窗，复用同一个容器 --></div>
<div id="toast"></div>
<div id="tabbar"><!-- 移动端底部 4 tab --></div>
```

---

## 3. 数据模型

用 JSDoc 定义，写在文件头部，作为唯一事实来源。

```js
/**
 * @typedef {Object} Task
 * @property {string}  id            // "t_" + 8位
 * @property {string}  title
 * @property {string}  projectId     // 可空
 * @property {'P0'|'P1'|'P2'} priority
 * @property {'todo'|'doing'|'done'} status
 * @property {string}  due           // "YYYY-MM-DD"，可空
 * @property {string}  aiContext     // AI 会话 URL，可空
 * @property {string}  blocker       // 一句话卡点，可空
 * @property {string[]} entryIds     // 关联知识条目
 * @property {number}  createdAt     // 秒级时间戳
 * @property {number}  updatedAt
 * @property {number|null} doneAt
 */

/**
 * @typedef {Object} Entry
 * @property {string}  id
 * @property {'prompt'|'snippet'|'pitfall'|'note'|'decision'} type
 * @property {string}  title
 * @property {string}  summary       // 必填，一行摘要
 * @property {string}  body          // Markdown，≤20KB
 * @property {string}  lang          // snippet 用
 * @property {string[]} tags
 * @property {string}  projectId
 * @property {string}  source
 * @property {'draft'|'verified'|'deprecated'} status
 * @property {1|2|3|4|5} rating
 * @property {number}  useCount
 * @property {number}  lastUsedAt
 * @property {{body:string, at:number}[]} revisions  // 最多 5 条
 * @property {number}  createdAt
 * @property {number}  updatedAt
 */

/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} repo
 * @property {string[]} stack
 * @property {'构思'|'开发'|'维护'|'暂停'|'归档'} stage
 * @property {string} nextStep      // 强制单一
 * @property {number} progress      // 0-100
 * @property {boolean} progressManual
 * @property {string} color
 */

/**
 * @typedef {Object} Ledger
 * @property {string} id
 * @property {string} date          // "YYYY-MM-DD"
 * @property {string} projectId
 * @property {string} tool          // claude-code|cursor|copilot|chatgpt|other
 * @property {string} scene         // 读代码|写功能|调试|重构|测试|文档|学习
 * @property {number} minutes
 * @property {number} savedMinutes
 * @property {1|2|3|4|5} effect
 * @property {string} note
 * @property {string} entryId
 */
```

### 3.1 存储键

```js
const K = {
  projects: 'wb_aidev_projects',
  tasks:    'wb_aidev_tasks',
  entries:  'wb_aidev_entries',
  ledger:   'wb_aidev_ledger',
  logs:     'wb_aidev_logs',      // [{ date, text, at }]
  settings: 'wb_aidev_settings',  // { theme, seeded, lastBackupAt, tipShownAt }
  schema:   'wb_aidev_schema',    // 1
};
```

### 3.2 数据层 API

```js
function read(key, fallback)        // JSON.parse 失败时返回 fallback，不抛错
function write(key, value)          // 配额超限时 catch，toast 提示"存储已满，请导出备份"
function uid(prefix)                // prefix + Math.random().toString(36).slice(2,10)
function nowSec()                   // Math.floor(Date.now()/1000)
function loadAll()                  // 一次性读全部表，返回 state 对象
function migrate(from, to)          // 版本升级钩子，当前只有 v1，留空实现
```

> `read` 必须 try/catch。localStorage 里可能是用户手改过的脏 JSON，抛错会导致整个页面白屏。

---

## 4. 计算层（纯函数，最该写测试的部分）

### 4.1 日期工具（最容易出 bug 的地方）

```js
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

function parseDate(s) {                 // 必须手动拆，不能用 new Date(s)
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);         // 本地 0 点
}

function diffDays(a, b) {               // a - b，单位天，正数表示 a 在后
  const MS = 86400000;
  return Math.round((parseDate(a) - parseDate(b)) / MS);
}
```

**为什么不能用 `new Date('2026-11-02')`**：ISO 纯日期字符串按 **UTC** 解析，东八区会变成当天 08:00（看起来没事），但西半球时区会退回前一天，跨月边界直接算错。而 `new Date(y, m-1, d)` 是本地时间，且 `Math.round` 能吸收夏令时的 ±1 小时偏移。

**边界用例（必须过）**：
- `diffDays('2026-03-01', '2026-02-28')` → 1
- `diffDays('2027-01-01', '2026-12-31')` → 1
- `diffDays('2026-02-01', '2026-01-31')` → 1
- 逾期天数 = `diffDays(todayStr(), task.due)`，结果 > 0 才算逾期

### 4.2 首页四类紧急项

```js
function getUrgentItems(state) {
  const today = todayStr();
  const open = state.tasks.filter(t => t.status !== 'done');

  return {
    overdue:  open.filter(t => t.due && diffDays(today, t.due) > 0),
    dueToday: open.filter(t => t.due === today),
    stalled:  open.filter(t =>
                t.status === 'doing' && diffDays(today, tsToDate(t.updatedAt)) > 3),
    drafts:   state.entries.filter(e =>
                e.status === 'draft' && diffDays(today, tsToDate(e.createdAt)) > 7),
  };
}
```

排序：`overdue` 按逾期天数降序 → `dueToday` 按优先级 → `stalled` 按停滞天数降序。

> `drafts` 是知识条目，不进入任务列表统计，只在置顶区显示为一条汇总提示「N 条草稿超过 7 天，去整理」，点击跳 `#kb?status=draft`。

### 4.3 搜索

```js
function tokenize(text) {
  const s = text.toLowerCase();
  const tokens = new Set();
  // 英文/数字：按非字母数字切，含驼峰；中文：连续汉字串切 2-gram
  s.replace(/[a-z0-9_$.#-]+/g, w => { tokens.add(w); return ''; });
  const cjk = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of cjk) {
    if (seg.length === 1) tokens.add(seg);
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
  }
  return tokens;
}

function scoreEntry(e, q) {
  const ql = q.toLowerCase();
  let s = 0;
  const t = e.title.toLowerCase();
  if (t === ql) s += 10;
  else if (t.startsWith(ql)) s += 6;
  else if (t.includes(ql)) s += 4;

  for (const tag of e.tags) {
    if (tag.toLowerCase().includes(ql)) s += 3;
  }
  const hay = (e.summary + '\n' + e.body + '\n' + (e.errorText || '')).toLowerCase();
  if (hay.includes(ql)) s += 1;

  if (e.lastUsedAt && nowSec() - e.lastUsedAt < 7 * 86400) s += 2;
  s += Math.min(e.useCount, 10) * 0.2;
  if (e.status === 'deprecated') s *= 0.5;
  return s;
}
```

**索引策略**（决策记录）：
- `< 500 条`：**不建索引**，直接线性 `scoreEntry` 全扫。1000 条 × 一次 includes，实测 < 15ms，用户无感。
- `>= 500 条`：构建 `Map<token, Set<id>>`，查询时取候选集再精确打分，索引用 `entriesUpdatedAt` 判断失效。
- **先做线性版，等真有 500 条再说**。过早优化会让代码多出 80 行且引入脏索引 bug。

中文 2-gram 是为了「断连」能命中「SSE 断连重试」——单字切分噪音太大，整串匹配命中率太低，2-gram 是这个场景的最优折中。

### 4.4 其他 selectors

```js
function computeProgress(projectId, tasks, manual)   // manual 优先，否则完成率取整
function getRelatedEntries(entry, all, n = 3)        // 共享标签数降序，排除自身
function getTopUsed(entries, n = 5)                  // useCount 降序，并列看 lastUsedAt
function entriesDueForArchive(entries, days = 30)    // draft/verified 且久未访问
function summarizeLedger(records, ym)                // 按 scene 聚合 avg(effect) 与 sum(savedMinutes)
function weekTrend(records)                          // 近 8 周 sum(savedMinutes)，喂折线图
```

---

## 5. 渲染层

### 5.1 渲染函数清单与签名

| 函数 | 输出目标 | 说明 |
|---|---|---|
| `renderNav(ctx)` | `#nav` + `#tabbar` | 当前路由高亮、置顶区红点数 |
| `renderToday(ctx)` | `#view` | 置顶区、任务分组、日志时间线、日志输入框 |
| `renderProjects(ctx)` | `#view` | 项目卡网格 |
| `renderProjectDetail(ctx)` | `#view` | 单项目三合一 |
| `renderKB(ctx)` | `#view` | 筛选树 + 条目列表 |
| `renderEntryDetail(ctx)` | `#view` | 正文、元信息、修订、相关条目 |
| `renderLedger(ctx)` | `#view` | 记录列表 + 两张 SVG 图 |
| `renderSettings(ctx)` | `#view` | 主题、备份、清空 |
| `renderStatus(ctx)` | `#status` | 已同步 / 同步中 / 离线 |
| `svgBar(items, opts)` | string | 纯函数返回 SVG 字符串 |
| `svgLine(points, opts)` | string | 同上 |

约定：视图渲染函数**返回 HTML 字符串**，由 `refreshAll` 统一 `view.innerHTML = html`，而不是各自操作 DOM。
好处：渲染函数变成纯函数，可单测、无中间态、不会出现「改了一半」的 DOM；代价是大列表全量重绘（2700 行规模下可接受，用户感知不到）。

### 5.2 事件处理：全局委托

**不给动态生成的元素绑事件**。所有交互用 `data-act` + `data-id` 声明，统一在 `document` 上委托一次：

```html
<button data-act="toggle-task" data-id="t_1a2b">完成</button>
<button data-act="copy-entry"  data-id="e_8f2a">复制</button>
```

```js
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el.dataset.id, el, e);
});

const ACTIONS = {
  'toggle-task':     id => { toggleTask(id); },
  'postpone-task':   id => { postponeTask(id, 1); },
  'promote-to-entry':id => { promoteToEntry(id); },
  'copy-entry':      id => { copyEntry(id); },
  'set-status':      (id, el) => { setEntryStatus(id, el.dataset.status); },
  'nav':             (_, el) => { location.hash = el.dataset.to; },
  // ...约 25 个
};
```

这一条能同时解决三个问题：动态渲染后事件丢失、重复绑定导致的内存泄漏、以及「点了没反应」类 bug 的排查成本。

### 5.3 HTML 转义（安全底线）

条目正文允许 Markdown 子集（标题、列表、代码块、链接、加粗），**渲染前必须先 escape**：

```js
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// 顺序：先 esc，再渲染 Markdown 结构，绝不允许把用户输入直接拼进标签
```

否则一条含 `<img onerror=...>` 的 note 就能执行脚本（虽然是自己用，但从剪藏来的内容是外部数据）。

### 5.4 骨架屏与空状态

- 首屏数据量小，不做骨架屏，直接渲染。
- 每个列表必须有**空状态**：一行灰字 + 一个主动作按钮，不留白框。
  - 示例：「还没有项目 · 新建第一个项目」「没搜到「sse」 · 用它新建一条」

---

## 6. 调度层

### 6.1 路由

hash 路由，7 条规则：

```js
function route() {
  const raw = location.hash.slice(1) || 'today';
  const [path, qs] = raw.split('?');
  const [page, id] = path.split('/');
  const params = new URLSearchParams(qs || '');
  return { page, id, params };   // 写入 ctx，refreshAll 按 page 分发
}
```

| hash | 视图 |
|---|---|
| `#today` | 今日聚焦 |
| `#projects` | 项目雷达 |
| `#project/p_01` | 项目详情 |
| `#kb` | 知识库（可带 `?type=&tag=&status=&q=`） |
| `#kb/e_8f2a` | 条目详情 |
| `#ledger` | AI 台账 |
| `#settings` | 设置 |

**关键**：路由只决定「显示哪个视图」，**不承载业务状态**。所有业务状态从 store 读。这样刷新页面、前进后退、分享链接都不会出现状态不一致。

### 6.2 统一刷新入口

```js
function buildContext() {
  const state = loadAll();
  const r = route();
  return { state, r, today: todayStr(), theme: state.settings.theme };
}

function refreshAll() {
  const ctx = buildContext();
  document.documentElement.dataset.theme = ctx.theme;

  renderNav(ctx);
  renderStatus(ctx);

  const map = {
    today: renderToday, projects: renderProjects, project: renderProjectDetail,
    kb: renderKB, ledger: renderLedger, settings: renderSettings,
  };
  const view = ctx.r.page === 'kb' && ctx.r.id ? renderEntryDetail : (map[ctx.r.page] || renderToday);
  document.getElementById('view').innerHTML = view(ctx);
}
```

> 每次 `refreshAll` 都全量读 store。1000 条 JSON 反序列化约 3ms，换来的是**零状态同步 bug**，非常划算。不要为了省 3ms 去维护增量更新。

### 6.3 动作层统一模式

```js
function toggleTask(id) {
  const tasks = read(K.tasks, []);
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  t.status = t.status === 'done' ? 'todo' : 'done';
  t.doneAt = t.status === 'done' ? nowSec() : null;
  t.updatedAt = nowSec();
  write(K.tasks, tasks);
  refreshAll();          // ← 只有这一句，不允许再调别的 render
}
```

**每个 action 的结构固定三行**：变更数据 → 落盘 → `refreshAll()`。没有例外。

---

## 7. 关键功能实现要点

### 7.1 复制到剪贴板（必须降级）

```js
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
```

`navigator.clipboard` 在非 HTTPS 的 `file://` 或 http 环境下不可用，必须保留 `execCommand` 兜底——而这个工作台的主要使用方式恰恰可能是本地双击打开。

复制成功后：`useCount++`、`lastUsedAt = nowSec()`、`toast('已复制')`、`refreshAll()`。

### 7.2 一键沉淀（闭环的关键交互）

```js
function promoteToEntry(taskId) {
  const t = read(K.tasks, []).find(x => x.id === taskId);
  const entry = {
    id: uid('e_'),
    type: 'pitfall',                                  // 默认按卡点推断
    title: t.blocker || t.title,
    summary: '',                                      // 留空，列表标"待补摘要"
    body: `**任务**：${t.title}\n\n**卡点**：${t.blocker || ''}\n\n**解**：`,
    tags: [],
    projectId: t.projectId || '',
    status: 'draft',
    useCount: 0, lastUsedAt: 0,
    revisions: [],
    createdAt: nowSec(), updatedAt: nowSec(),
  };
  write(K.entries, [...read(K.entries, []), entry]);
  t.entryIds = [...(t.entryIds || []), entry.id];
  write(K.tasks, read(K.tasks, []).map(x => x.id === taskId ? t : x));
  location.hash = `#kb/${entry.id}`;                  // 直接打开详情，光标落在正文
  refreshAll();
}
```

设计意图：**预填到「只差一个解」的程度**。如果打开后是一片空白表单，用户会关掉；预填了任务和卡点，用户只需要补两句话。

### 7.3 快速捕获浮层

- 快捷键 `N`（输入框聚焦时不触发）、移动端右下角悬浮按钮
- 只有两个字段：标题、正文；`Cmd+Enter` 保存，`Esc` 关闭
- 默认落 `note` 类型，保存后 toast 里给「改成踩坑 / 提示词」的快捷操作
- 浮层与搜索浮层**复用 `#overlay` 容器**，同一时间只存在一个

### 7.4 SVG 图表（两张，手写）

**条形图**（场景 × 平均效果分）：

```js
function svgBar(items, { w = 520, h = 220, max = 5 }) {
  const padL = 72, padB = 24, bw = (w - padL - 16) / items.length;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">
    ${items.map((it, i) => {
      const bh = (it.value / max) * (h - padB - 12);
      const x = padL + i * bw + bw * 0.18;
      const y = h - padB - bh;
      return `<rect x="${x}" y="${y}" width="${bw * 0.64}" height="${bh}"
                    rx="4" fill="var(--primary)" opacity=".85"/>
              <text x="${x + bw * 0.32}" y="${h - 8}" text-anchor="middle"
                    font-size="11" fill="var(--text-dim)">${it.label}</text>
              <text x="${x + bw * 0.32}" y="${y - 6}" text-anchor="middle"
                    font-size="11" fill="var(--text)">${it.value.toFixed(1)}</text>`;
    }).join('')}
  </svg>`;
}
```

**折线图**（近 8 周节省时间）：`viewBox` + `polyline` + 圆点，坐标用 min/max 归一化。**空数据不画线，显示一行灰字**。

所有颜色用 CSS 变量（`var(--primary)`），这样切换主题时图表自动跟随，不需要重绘。

### 7.5 主题切换

```css
:root[data-theme="dark"]  { --bg:#0F1117; --surface:#171A22; --border:#262A35;
                            --text:#E6E8EE; --text-dim:#8B93A7;
                            --primary:#7C5CFF; --danger:#FF5C5C;
                            --success:#3DD68C; --warn:#FFB020; }
:root[data-theme="light"] { --bg:#FAFAFB; --surface:#FFFFFF; --border:#E7E8EC;
                            --text:#1A1D24; --text-dim:#6B7280;
                            --primary:#5B47E0; --danger:#DC2626;
                            --success:#16A34A; --warn:#D97706; }
```

`document.documentElement.dataset.theme = 'dark'`，值存 `settings.theme`。首屏在 `<head>` 里内联一段同步脚本先设上，避免亮色闪一下（FOUC）。

### 7.6 移动适配

| 项 | 规则 |
|---|---|
| 断点 | `@media (max-width: 767px)` 单列 |
| 导航 | 侧栏 `display:none`，`#tabbar` 固定在底部 |
| 点击区 | 按钮 `min-height: 44px; min-width: 44px` |
| 输入框 | `font-size: 16px`（小于 16px 会触发 iOS 自动缩放） |
| 安全区 | `padding-bottom: calc(12px + env(safe-area-inset-bottom))` |
| 长内容 | 代码块 `overflow-x:auto`，不撑破布局 |
| 表格 | 台账在窄屏改为卡片列表，不做横向滚动 |

### 7.7 导入导出

```js
function exportJSON() {                 // 全量快照
  const dump = {
    schema: 1, exportedAt: new Date().toISOString(),
    projects: read(K.projects, []), tasks: read(K.tasks, []),
    entries: read(K.entries, []), ledger: read(K.ledger, []),
    logs: read(K.logs, []), settings: read(K.settings, {}),
  };
  download(`devdeck-backup-${todayStr()}.json`,
           JSON.stringify(dump, null, 2), 'application/json');
}

function importJSON(file) {             // 支持上千条，无上限
  // 1. FileReader 读取 → JSON.parse（失败则提示"文件格式不正确"）
  // 2. 校验 dump.schema，不等于 1 时走 migrate
  // 3. 按 id 合并：同 id 取 updatedAt 较新者；不同 id 全部保留
  // 4. 落盘 → refreshAll → toast 显示"N 条任务 / M 条知识已恢复"
}

function exportMarkdown() {             // 知识库单文件导出
  const md = entries.map(e => `---
title: ${e.title}
type: ${e.type}
tags: [${e.tags.join(', ')}]
status: ${e.status}
project: ${projectName(e.projectId)}
updated: ${fmtDate(e.updatedAt)}
---

# ${e.title}

> ${e.summary}

${e.body}
`).join('\n---\n\n');
  download(`devdeck-kb-${todayStr()}.md`, md, 'text/markdown');
}
```

`download()` 用 `Blob` + `URL.createObjectURL` + 临时 `<a>`，用完 `revokeObjectURL`。

### 7.8 数据量保护

| 阈值 | 行为 |
|---|---|
| 条目 `body > 20KB` | 拒绝保存，提示「单条正文上限 2 万字」 |
| 已完成任务 > 500 条 | 顶部提示「有 N 条已完成任务，可归档清理」 |
| 总数据 > 30 条 | 一次性提示「建议导出备份」，记 `settings.tipShownAt`，一天内不重复 |
| `write` 抛 QuotaExceededError | 阻止后续写入，弹窗引导导出，降级为只读 |

---

## 8. 开发里程碑

每个里程碑都是**可运行、可交付**的状态，不存在"写了一半打不开"的中间态。

| 里程碑 | 内容 | 预估代码量 | 验收点 |
|---|---|---|---|
| **M0 骨架** | CSS 令牌 + 组件样式、HTML 骨架、store、日期工具、路由、`refreshAll` 空壳、示例数据种子 | ~700 行 | 打开有样式、四个 tab 能切、示例数据已入库、控制台无报错 |
| **M1 今日聚焦** | 置顶区四类、任务分组列表、CRUD、完成/改期、开发日志、快速捕获浮层 | ~400 行 | 逾期任务红色、昨日项顺延、`N` 键可捕获、日志回车即存 |
| **M2 项目雷达** | 项目卡、新建/编辑、阶段、nextStep、进度自动算、详情页 | ~350 行 | 进度随任务完成变化、7 天未动标记出现、详情页三块数据正确 |
| **M3 知识库** | 列表 + 三维筛选 + 详情 + 编辑 + 复制 + 使用计数 + 生命周期 + 修订 + `Cmd+K` 搜索 | ~800 行 | 搜"断连"能命中、复制后 useCount+1、草稿能升 verified、修订可回滚 |
| **M4 台账** | 记录表单 + 月度聚合 + 两张 SVG 图 + 本月结论 | ~300 行 | 图表随数据变化、切主题颜色跟随、空数据不画线 |
| **M5 收尾** | 导入导出、主题切换、移动端打磨、空状态、冒烟、发布 | ~200 行 | 导出→清空→导入数据完整；375px 无横向滚动；Network 面板零请求 |

**建议拆分**：M3 是唯一有风险的里程碑（800 行）。如果再拆一次：
- M3a：列表 + 筛选 + 详情（只读，能看不能改）——~350 行
- M3b：编辑器 + 复制 + 生命周期 + 修订 + 搜索——~450 行

---

## 9. 测试方案

### 9.1 手工冒烟清单（每次里程碑结束必过）

1. **调用链无环**：`refreshAll` 里每个 render 只出现一次；render 函数体内无 render 互调
2. **初始化通畅**：`DOMContentLoaded` → `migrate` → `loadAll` → 无数据则 `seedDemo` → `refreshAll`；所有被调函数在调用点之前定义
3. **DOM 目标存在**：所有 `getElementById` 的 id 在 HTML 中存在（用 `console.assert` 兜一层）
4. **空数据不崩**：清空所有表后逐个视图点一遍，只出现空状态
5. **日期边界**：3 个用例（见 4.1）+ 手动把系统时间调到 23:59 验证「今天」判定
6. **事件绑定**：连续切换视图 10 次，点按钮仍只触发一次（验证委托无重复绑定）
7. **剪贴板降级**：`file://` 下打开，复制仍成功
8. **零外链**：DevTools Network 面板，除文档本身外**零请求**
9. **移动端**：375×667 下无横向滚动，输入框聚焦不缩放
10. **数据往返**：导出 → 清空 → 导入 → 条数、内容、useCount 完全一致

### 9.2 可选：纯函数单测

计算层是纯函数，值得测。但单文件 HTML 没法直接 `import`。两个选择：

**方案 A（推荐，零成本）**：不写自动化测试，靠 9.1 的清单 + 控制台手动验证。

**方案 B（愿意多花 30 分钟）**：开发期把 `selectors` 单独放在 `src/selectors.js`（ESM export），用 Node 22 内置 test runner：

```bash
node --test tests/
```

```js
// tests/date.test.js
import test from 'node:test';
import assert from 'node:assert';
import { diffDays } from '../src/selectors.js';

test('跨月', () => assert.equal(diffDays('2026-03-01', '2026-02-28'), 1));
test('跨年', () => assert.equal(diffDays('2027-01-01', '2026-12-31'), 1));
```

交付前用 20 行的 `build.mjs` 把 `src/*.js` 按顺序拼进 `index.html`（去掉 `export` 关键字），产物仍是单文件。

**取舍建议**：如果只做一次、不再迭代，选 A；如果打算长期加功能，选 B——日期和搜索这两个函数一定会被改，有测试能省掉大量回归时间。

---

## 10. 发布

| 方式 | 步骤 | 适用 |
|---|---|---|
| **本地文件** | 直接把 `index.html` 存到本地，双击打开 | 单人、单机、离线 |
| **在线链接** | 发布到资料库「在线 page」，得到一个 URL | 手机、多设备、想加到桌面 |
| **资料库数据表** | 建 `aidev_projects` / `aidev_tasks` / `aidev_entries` / `aidev_ledger` 四张表，页面读写走数据表 | 需要云端同步 |

发布到线上时补两件事：
1. 右上角状态指示器接入真实同步状态（已同步 / 同步中 / 离线）
2. 断网时自动降级 localStorage，恢复后批量补推；冲突按 `updatedAt` 取新，数组按 id 取并集

**隐私提醒**：部署后链接是公网可访问的。示例数据里不要放真实仓库地址、内网域名、API key。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| render 之间互调导致栈溢出 | 页面白屏 | 分层规则 + 每条里程碑扫一遍互调正则 |
| `new Date('YYYY-MM-DD')` 时区偏移 | 逾期计算错一天 | 强制 `parseDate` 手动拆解，禁用字符串构造 |
| localStorage 写满 | 保存静默失败，用户以为存上了 | `write` 必须 catch 并弹窗，不能吞异常 |
| 单文件 2700 行难维护 | 改 A 坏 B | 六分区注释 + 函数命名带模块前缀（`kbXxx` / `todayXxx`） |
| 动态元素事件丢失 | 点了没反应 | 全局 `data-act` 委托，禁止 `onclick` 内联 |
| 用户输入未转义 | XSS（剪藏内容） | 所有正文先 `esc()` 再渲染 Markdown |
| 知识库没人写 | 功能空转 | 从任务卡、项目卡、快捷键三个入口导流，预填到"只差一个解" |
| 一次性写完整个文件 | 输出截断，拿到半成品 | 严格按 M0→M5 增量写入，每个里程碑结束都是可运行状态 |

---

## 12. 完成定义（DoD）

一个里程碑算"完成"，必须同时满足：

- [ ] 页面能打开，控制台零报错、零警告
- [ ] 该里程碑的验收点逐条通过
- [ ] 第 9.1 节清单中相关项通过
- [ ] 没有引入任何外部请求
- [ ] 375px 宽度下可用
- [ ] 代码落在正确分区，没有跨层调用

整个项目算"完成"，额外要求：

- [ ] 导出 → 清空 → 导入，数据零丢失
- [ ] 手机浏览器打开可用，可添加到主屏幕
- [ ] 示例数据可一键清空
- [ ] 连续使用 30 条数据后，备份提示正常出现

---

## 13. 附录：命名与编码约定

| 项 | 约定 | 示例 |
|---|---|---|
| 函数 | 小驼峰，动宾结构，带模块前缀 | `renderKB` / `toggleTask` / `getUrgentItems` |
| 常量 | 全大写下划线 | `K`（存储键）、`SCENES`、`STAGES` |
| DOM id | 短名 | `#view` `#nav` `#overlay` |
| data 属性 | 短横线 | `data-act` `data-id` `data-status` |
| CSS 类 | BEM 简化：`块-元素`，状态用 `is-` | `.task` `.task-title` `.is-overdue` |
| 事件 | 只用委托，禁止内联 `onclick` | `[data-act]` |
| 异步 | 只有剪贴板和文件读取用 async | 其余全同步 |
| 注释 | 每个分区头部写「这一层能做什么、不能做什么」 | — |

**不要做的事**：
- 不要为了"以后可能要"提前抽象（比如做个通用表单生成器）
- 不要在 render 里做数据计算（放到 selectors）
- 不要在 store 里写业务判断（它只负责存取）
- 不要引入 `requestAnimationFrame` 做动画（这个工具的定位是"看一眼就走"）
