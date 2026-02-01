# 🎯 快速参考卡

## 📌 今天结束工作时要做的事

### ✅ 必须做的
```bash
# 1. 停止开发服务器
# 按 Ctrl+C 停止 npm run dev

# 2. 清理 PM2 测试进程
npx pm2 delete all

# 3. 提交所有代码
git status                     # 查看修改
git add .                      # 暂存文件
git commit -m "类型: 描述"     # 提交
git push origin main           # 推送

# 4. 更新进度文档
# 编辑 PROGRESS.md:
# - 标记完成的任务 [x]
# - 添加明天的计划
# - 记录今日工作日志
```

### 💡 建议做的
- 检查是否有未提交的修改
- 清理测试数据 `apps/test-*`
- 记录遇到的问题和解决方案
- 规划明天的任务

---

## 🌅 明天开始工作时要做的事

### ✅ 启动流程
```bash
# 1. 进入项目目录并更新代码
cd /path/to/microverse
git pull origin main

# 2. 查看今天的任务
cat PROGRESS.md | grep -A 10 "立即任务"

# 3. 启动开发环境
npm run dev

# 4. 验证环境
curl http://localhost:5000/api/health  # 后端
curl http://localhost:5173             # 前端
npx pm2 list                           # PM2状态
```

### 📖 阅读清单
1. `PROGRESS.md` → 了解待办事项
2. `WORKFLOW.md` → 如果忘记流程
3. `CLAUDE.md` → 如果要修改架构

---

## 🔥 常用命令速查

### 开发
```bash
npm run dev              # 启动前后端
npm run dev:server       # 只启动后端
npm run dev:client       # 只启动前端
```

### 测试
```bash
curl http://localhost:5000/api/health        # 健康检查
curl http://localhost:5000/api/apps          # 应用列表
npx pm2 list                                 # PM2进程
```

### Git
```bash
git status               # 查看状态
git add .               # 暂存所有
git commit -m "msg"     # 提交
git push origin main    # 推送
```

### PM2
```bash
npx pm2 list            # 列出进程
npx pm2 logs <name>     # 查看日志
npx pm2 delete <name>   # 删除进程
npx pm2 delete all      # 删除所有
```

### 清理
```bash
npx pm2 delete all                    # 清理PM2
rm -rf apps/test-*                    # 清理测试应用
rm data/microverse.sqlite             # 重置数据库
```

---

## 🚨 紧急问题快速修复

### 端口占用
```bash
# Windows
netstat -ano | findstr :5000
taskkill //F //PID <PID>

# Linux/Mac
lsof -i :5000
kill -9 <PID>
```

### PM2 无法启动
```bash
npx pm2 delete all
npx pm2 kill
# 重启服务器
```

### 数据库锁定
```bash
# 停止所有服务
rm data/microverse.sqlite
npm run dev:server  # 重新创建
```

---

## 📋 检查清单

### 每日开始 ☑️
- [ ] `git pull origin main`
- [ ] 查看 `PROGRESS.md`
- [ ] `npm run dev`
- [ ] 验证环境运行正常

### 每日结束 ☑️
- [ ] 测试功能
- [ ] `git commit` 并 `git push`
- [ ] 更新 `PROGRESS.md`
- [ ] `npx pm2 delete all`
- [ ] 记录工作日志

### 添加新功能 ☑️
- [ ] 查看 `PROGRESS.md` 确认优先级
- [ ] 创建功能分支（可选）
- [ ] 开发并测试
- [ ] 更新文档
- [ ] 提交推送

---

## 📚 文档快速链接

| 文档 | 用途 | 何时查看 |
|------|------|---------|
| [README.md](README.md) | 使用指南 | 第一次使用 |
| [CLAUDE.md](CLAUDE.md) | 架构详解 | 修改代码前 |
| [PROGRESS.md](PROGRESS.md) | 进度跟踪 | 每天开始 |
| [WORKFLOW.md](WORKFLOW.md) | 工作流程 | 忘记步骤时 |
| [DOCS.md](DOCS.md) | 文档索引 | 找不到文档时 |

---

**💡 提示**: 把这个文件加入书签，每天开始和结束工作时查看！
