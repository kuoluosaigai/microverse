# 工作流程指南

本文档描述 Microverse 项目的日常开发工作流程，确保开发的连续性和规范性。

## 📋 每日工作流程

### 🌅 开始一天的工作

#### 1. 环境准备
```bash
# 进入项目目录
cd /path/to/microverse

# 拉取最新代码
git pull origin main

# 检查当前分支
git branch

# 如有必要，更新依赖
npm run install:all
```

#### 2. 查看项目状态
```bash
# 查看最近的提交
git log --oneline -5

# 查看工作区状态
git status

# 阅读开发进度文档
cat PROGRESS.md | head -50
```

#### 3. 阅读关键文档
- 📖 `PROGRESS.md` - 了解当前进度和待办事项
- 📖 `CLAUDE.md` - 如果是 Claude Code，先阅读开发指南
- 📖 `README.md` - 必要时查看使用说明

#### 4. 启动开发环境
```bash
# 方式1: 同时启动前后端（推荐）
npm run dev

# 方式2: 分别启动
# 终端1: 启动后端
npm run dev:server

# 终端2: 启动前端
npm run dev:client
```

#### 5. 验证环境
```bash
# 检查后端运行状态
curl http://localhost:5000/api/health

# 检查前端运行状态
curl http://localhost:5173

# 检查 PM2 进程
npx pm2 list

# 如果有遗留进程，清理它们
npx pm2 delete all
```

#### 6. 确定今天的任务
- 查看 `PROGRESS.md` 的"下一步计划"部分
- 选择一个优先级高的任务
- 如果是 bug 修复，查看"已知问题"部分

---

### 💻 开发过程中

#### 创建功能分支（可选，但推荐）
```bash
# 为新功能创建分支
git checkout -b feature/upload-files

# 或为 bug 修复创建分支
git checkout -b fix/pm2-restart-issue
```

#### 代码修改规范
1. **遵循现有代码风格**
   - 使用 async/await（不使用回调）
   - 所有数据库操作必须 await
   - 使用 `path` 模块处理路径
   - 使用 `cross-env` 设置环境变量

2. **修改前阅读相关文档**
   - 修改后端：阅读 `CLAUDE.md` 的架构部分
   - 修改数据库：检查 `server/src/db/schema.sql`
   - 修改配置：检查 `server/src/config/index.js`

3. **测试你的修改**
   ```bash
   # 后端修改：测试 API
   curl http://localhost:5000/api/...

   # 前端修改：在浏览器中测试
   # 访问 http://localhost:5173

   # 进程管理修改：测试 PM2
   npx pm2 list
   npx pm2 logs <app-name>
   ```

#### 提交代码规范
```bash
# 1. 查看修改
git status
git diff

# 2. 暂存文件
git add <specific-files>  # 推荐：只添加相关文件
# 或
git add -A  # 添加所有修改

# 3. 提交（使用规范的 commit message）
git commit -m "类型: 简短描述

详细说明（可选）：
- 修改了什么
- 为什么修改
- 如何测试

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Commit 消息类型**:
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式（不影响功能）
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具配置

---

### 🌙 结束一天的工作

#### 1. 测试验证
```bash
# 运行完整功能测试（如果有）
npm test  # 当前项目没有测试，跳过

# 手动测试关键功能
# - 创建应用
# - 启动应用
# - 停止应用
# - 删除应用
```

#### 2. 代码提交
```bash
# 确保所有修改都已提交
git status

# 如有未提交的修改，决定是提交还是暂存
git add .
git commit -m "feat: 今日工作描述

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

# 或使用 stash 保存未完成的工作
git stash save "WIP: 功能描述"
```

#### 3. 推送到远程仓库
```bash
# 推送主分支
git push origin main

# 或推送功能分支
git push origin feature/your-feature
```

#### 4. 更新文档
```bash
# 更新 PROGRESS.md
# - 将完成的任务标记为 [x]
# - 添加新发现的问题到"已知问题"
# - 更新"下一步计划"

# 如有重要架构变更，更新 CLAUDE.md
```

#### 5. 清理环境
```bash
# 停止开发服务器（Ctrl+C）

# 清理 PM2 测试进程
npx pm2 delete all

# 可选：清理测试数据
rm -rf apps/test-*
rm data/microverse.sqlite  # 仅在需要重置数据库时

# 查看进程（确保没有遗留）
npx pm2 list
```

#### 6. 记录工作日志（推荐）
在 `PROGRESS.md` 底部添加每日工作记录：
```markdown
## 工作日志

### 2026-02-02
- ✅ 完成项目初始搭建
- ✅ 实现前后端核心功能
- ✅ 测试通过并推送到 GitHub
- 📝 下次: 实现文件上传功能
```

---

## 🔄 特定场景流程

### 场景1: 修复紧急 Bug

```bash
# 1. 创建 hotfix 分支
git checkout -b hotfix/critical-bug-name

# 2. 修复并测试
# ... 修改代码 ...
# ... 测试验证 ...

# 3. 提交和推送
git add .
git commit -m "fix: 修复紧急 bug 描述"
git push origin hotfix/critical-bug-name

# 4. 合并到主分支
git checkout main
git merge hotfix/critical-bug-name
git push origin main

# 5. 删除分支
git branch -d hotfix/critical-bug-name
```

### 场景2: 添加新功能

```bash
# 1. 查看 PROGRESS.md，选择待实现功能
# 2. 创建功能分支
git checkout -b feature/new-feature-name

# 3. 开发功能
# - 修改后端：server/src/
# - 修改前端：client/src/
# - 更新文档：README.md, CLAUDE.md

# 4. 测试功能
# - 手动测试
# - 更新 PROGRESS.md 标记完成

# 5. 提交推送
git add .
git commit -m "feat: 新功能描述"
git push origin feature/new-feature-name

# 6. 合并（或创建 PR）
git checkout main
git merge feature/new-feature-name
git push origin main
```

### 场景3: 数据库 Schema 变更

```bash
# 1. 修改 schema
# 编辑 server/src/db/schema.sql

# 2. 删除旧数据库（开发环境）
rm data/microverse.sqlite

# 3. 重启服务器（自动创建新数据库）
npm run dev:server

# 4. 验证新 schema
# 测试相关 API 功能

# 5. 更新相关代码
# - server/src/db/index.js (查询函数)
# - server/src/services/*.js (使用新字段)
# - client/src/api/*.js (前端 API)

# 6. 更新文档
# 在 CLAUDE.md 中记录 schema 变更
```

### 场景4: 依赖包更新

```bash
# 1. 备份当前状态
git commit -am "chore: backup before dependency update"

# 2. 更新依赖
npm update  # 或
npm run install:all

# 3. 测试
npm run dev
# 手动测试关键功能

# 4. 如有问题，回滚
git reset --hard HEAD^

# 5. 如成功，提交
git add package*.json */package*.json
git commit -m "chore: update dependencies"
```

### 场景5: 中断后恢复开发

```bash
# 1. 检查是否有未提交的修改
git status

# 2. 如果有 stash，恢复它
git stash list
git stash pop

# 3. 查看上次工作记录
git log -1 --stat
cat PROGRESS.md | grep "下次:"

# 4. 恢复开发环境
npm run dev

# 5. 继续开发...
```

---

## 📝 最佳实践

### 代码质量
1. **频繁提交** - 每完成一个小功能就提交
2. **清晰的 commit 消息** - 使用规范的格式
3. **测试后再提交** - 确保修改不破坏现有功能
4. **保持分支整洁** - 及时删除已合并的分支

### 文档维护
1. **同步更新文档** - 修改代码后立即更新相关文档
2. **记录决策** - 重要技术决策记录在 CLAUDE.md
3. **更新进度** - 每日更新 PROGRESS.md

### 环境管理
1. **不提交敏感信息** - .env 文件不要提交
2. **不提交运行时数据** - apps/*, data/*.sqlite 已在 .gitignore
3. **定期清理** - 删除测试应用和 PM2 进程

### 协作开发
1. **拉取后再推送** - `git pull` before `git push`
2. **解决冲突** - 仔细检查合并冲突
3. **代码审查** - 合并前检查 git diff

---

## 🆘 常见问题和解决方案

### 问题1: 端口被占用
```bash
# Windows
netstat -ano | findstr :5000
taskkill //F //PID <PID>

# Linux/Mac
lsof -i :5000
kill -9 <PID>
```

### 问题2: PM2 进程无法启动
```bash
# 查看日志
npx pm2 logs <app-name> --lines 50

# 删除所有进程重新开始
npx pm2 delete all
npx pm2 kill
```

### 问题3: 数据库锁定
```bash
# 关闭所有使用数据库的进程
# 重启服务器
rm data/microverse.sqlite  # 如果必要，重新创建
```

### 问题4: 依赖安装失败
```bash
# 清理缓存
rm -rf node_modules */node_modules
rm package-lock.json */package-lock.json

# 重新安装
npm run install:all
```

### 问题5: Git 冲突
```bash
# 查看冲突文件
git status

# 手动解决冲突后
git add <resolved-files>
git commit -m "merge: 解决冲突"
```

---

## 📚 参考文档

开发时参考以下文档：
- `README.md` - 项目使用说明
- `CLAUDE.md` - 架构和开发指南
- `PROGRESS.md` - 开发进度和待办事项
- `.env.example` - 配置说明
- `server/src/db/schema.sql` - 数据库结构

---

**记住**: 频繁提交、充分测试、保持文档同步！
