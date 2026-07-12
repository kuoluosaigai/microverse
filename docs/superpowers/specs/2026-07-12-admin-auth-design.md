# 管理员认证（Phase 14，单管理员登录部分）— 设计文档

- **日期**: 2026-07-12
- **状态**: Approved (design)
- **范围**: Phase 14 的第一块——给 admin UI + API 加一道**单管理员登录**，堵住"服务绑 0.0.0.0，局域网谁都能部署/删除/启停应用"的口子。
- **不在范围**: 多用户/多租户、注册、RBAC、app 归属隔离、改密端点、登录限流、CSRF token、对部署应用本身的访问保护。

## 背景

当前平台**零认证**：server/src 无任何 auth/login/jwt 代码，无 auth 依赖，schema 无 user/owner 表。服务默认绑 `0.0.0.0:5000`，LAN 内任何人都可操作。

Phase 14 列了 4 项（注册/登录、JWT、权限、多用户隔离），但对这个"单人托管微应用"的工具，**多用户是过度设计**。真实痛点是 admin 面板裸奔。故 v1 只做**单管理员登录**。

## 关键决策（brainstorm 已确认）

1. **范围 = 单管理员登录**（一个管理员账号保护整个 admin UI + API；不做注册/多用户/app 归属）。
2. **机制 = express-session（session cookie）**，不用 JWT——单管理员 + Web UI 下，session 更简单，JWT 的无状态收益边际。
3. **凭据存储 = env 播种的 users 表（bcrypt）**——env 变量只在首次播种时用一次（明文→哈希入 DB），不留持久明文；users 表已在，将来扩多用户有路。
4. **`bcryptjs` 不用 `bcrypt`**——bcrypt 是 native binding，有和 better-sqlite3 一样的 Windows 编译坑；bcryptjs 纯 JS、零编译、API 兼容。

## 架构

### 数据模型 + 管理员播种

新增 `users` 表（`schema.sql`，`CREATE TABLE IF NOT EXISTS`，加性、无需删库）：

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**播种**（新 `AuthManager.ensureAdmin()`，启动时 db 初始化后调一次）：若 `users` 表为空，从 `ADMIN_USERNAME`（默认 `admin`）+ `ADMIN_PASSWORD` 读明文，**bcryptjs 哈希后插入一行**，之后忽略 env。表非空则跳过——env 只在首次播种时用一次，不留持久明文。（改密 v1 不做；需改就删该行重启重播种，或后续加 change-password。）

### session 中间件

`express-session`（新依赖），`app.js` 里在路由之前挂载：

```js
app.use(session({
  secret: config.auth.sessionSecret,          // SESSION_SECRET env；未设则启动随机生成 + warn
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 } // 8h
}));
```

内存 store（默认 MemoryStore）。服务跑 PM2 fork **单进程**，内存 store 够用；重启 = 重新登录一次（单管理员无所谓，记为限制）。httpOnly + sameSite=lax（见安全取舍）。

### `requireAuth` 中间件 + 受保护范围

新 `server/src/middleware/auth.js`：未登录 → 401 `{success:false, error:{message:'Authentication required'}}`；`req.session.user` 存在 → next()。

**挂载方式（Express 注册顺序技巧）**：`routes/index.js` 里先注册公开路由，再 `router.use(requireAuth)`，再注册受保护路由——公开路由先匹配到直接返回、不经过 requireAuth；后面的路由必须过 requireAuth。

| 公开（不拦） | 受保护（拦） |
|---|---|
| `GET /api/health` | 所有 `/api/apps*`（CRUD/启停/上传/日志/env/metrics） |
| `GET /api/config` | `POST /api/auth/logout`、`GET /api/auth/me` |

> 部署的应用本身（各自端口上的进程）**不**受这套认证保护——独立进程，超出范围。

### auth 路由

- `POST /api/auth/login` `{username, password}` → 登录时 `req.session.regenerate()`（防 session fixation）再 bcryptjs.compare 对 DB → 成功 `req.session.user = {id, username}` 返回 `{success, data:{user}}`；失败 401 `Invalid credentials`。
- `POST /api/auth/logout` → `req.session.destroy()` + 清 cookie。
- `GET /api/auth/me` → 有 session 返回 user，否则 401（前端启动探测用）。

### 配置 + 依赖

`config.auth`：
- `adminUsername = process.env.ADMIN_USERNAME || 'admin'`
- `adminPassword = process.env.ADMIN_PASSWORD || ''`（空则播种跳过 + warn）
- `sessionSecret = process.env.SESSION_SECRET || <启动时随机+warn>`

`.env.example` 加 `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `SESSION_SECRET`。`server/package.json` 加依赖：`bcryptjs`、`express-session`。

## 前端

### AuthContext + 登录页 + 路由守卫 + 登出

**`client/src/context/AuthContext.jsx`**（auth 是横切关注点，用 context 免逐页 prop-drill）：state `{ user, checking }`；挂载时调 `getMe()` → 200 设 user、401 设 null、checking 结束；暴露 `login` / `logout` / `user` / `checking`。App.jsx 用 `<AuthProvider>` 包整棵树。

**`client/src/api/auth.js`**：`login` / `logout` / `getMe`。
**`client/src/api/apps.js`**：现有 axios 实例加 `withCredentials: true`（保证 session cookie 随请求带）。

**`client/src/pages/Login.jsx`**：EditorialShell + 用户名/密码表单 → `login()` → 成功 navigate('/')；失败 `message.error`；已登录则跳 /。

**路由守卫**（App.jsx）：`/login` 公开；其余包在一个 layout route 里，element 是 `RequireAuth`（`checking` 时 loading、无 user 时 `<Navigate to="/login">`、否则 `<Outlet/>`）。

**登出**：`EditorialShell` 消费 `useAuth()`，有 user 时在 topbar 加 logout 控制。

## 安全取舍（明确写入，避免日后当 bug）

- **CSRF**：v1 **不加 CSRF token**。缓解：session cookie `sameSite:'lax'`（拦掉跨站 POST）+ 所有写操作走 JSON `Content-Type`（跨站无法伪造 JSON 请求而不触发 CORS 预检）。对本地单管理员工具足够。
- **session fixation**：登录时 `req.session.regenerate()` 再写 user——低成本好习惯，纳入 v1。
- **登录暴力破解**：v1 **不加限流**（限流是独立技术债）。记为限制。
- **密码强度**：不强制策略（单管理员，运维自决）。

## 错误处理

- 登录失败 / 受保护路由未登录 → 401 envelope `{success:false, error:{message}}`。
- 播种失败（bcrypt 出错等）→ `console.warn` + 继续启动，不崩。
- 前端挂载 `getMe()` 收 401 → **静默**设 user=null（正常"未登录"态，不弹错误 toast）。

## 测试

本特性**不引入测试框架**。手动测试矩阵：

```
1. 设 ADMIN_USERNAME/ADMIN_PASSWORD，启动 → 日志可见 admin 已播种
2. curl GET /api/apps（无 cookie）→ 401
3. curl POST /api/auth/login 错密码 → 401；正确 → 200 + Set-Cookie
4. curl GET /api/apps（带 cookie jar）→ 200
5. curl POST /api/auth/logout → 再 GET /api/apps → 401
6. 前端：打开 → 跳 /login；登录 → Dashboard；登出 → 回 /login
负向：ADMIN_PASSWORD 未设且 users 空 → warn，登录不可用（运维设 env 修复）
```

**自然可测单元**（待引入测试框架）：`requireAuth` 中间件、`AuthManager.ensureAdmin` 播种逻辑（空表→播种、非空→跳过）、login 的 bcrypt 比对。

## 已知限制 / 范围外

1. **内存 session**：重启即失效，重新登录一次。
2. **无 CSRF token**（sameSite=lax + JSON 缓解，本地单管理员足够）。
3. **无登录限流**（暴力破解防护 = 限流技术债，另做）。
4. **无改密端点**（删 users 行重启重播种，或后续加）。
5. **部署应用本身（各自端口）不受此认证保护**——独立进程，超出范围。
6. **仅单管理员**（设计如此；users 表已在，将来扩多用户有路）。
7. `SESSION_SECRET` 未设时启动随机生成 → 每次重启 session 全失效。

## 改动面 checklist（实现时用）

**后端**
- `server/src/db/schema.sql` — users 表
- `server/src/db/index.js` — createUser / getUserByUsername 查询
- NEW `server/src/services/auth-manager.js` — `ensureAdmin()`（播种）+ `verifyCredentials()`（bcrypt 比对）
- NEW `server/src/middleware/auth.js` — `requireAuth`
- `server/src/routes/index.js` — auth 路由 + requireAuth 注册顺序
- `server/src/app.js` — session 中间件 + 启动 `ensureAdmin()`
- `server/src/config/index.js` + `.env.example` — `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `SESSION_SECRET`
- `server/src/docs/openapi.yaml` — auth 端点 + 受保护端点 401
- `server/package.json` — `bcryptjs`、`express-session`

**前端**
- NEW `client/src/context/AuthContext.jsx`
- NEW `client/src/pages/Login.jsx`
- NEW `client/src/api/auth.js`
- `client/src/App.jsx` — AuthProvider + /login 路由 + RequireAuth layout route
- `client/src/components/EditorialShell.jsx` — logout 控制
- `client/src/api/apps.js` — `withCredentials: true`
- `client/src/i18n/locales/{zh,en}.json` — 登录/登出文案

**文档**
- `PROGRESS.md` — Phase 14 勾"单管理员登录"；多用户/JWT 权限/隔离仍待办
- `README.md` — 提及管理员登录
