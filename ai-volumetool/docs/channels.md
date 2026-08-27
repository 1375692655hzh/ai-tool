# 渠道配置指南

添加渠道入口：**右键宠物 → 设置 → 添加渠道**。每张渠道卡选一个「厂商模板」，按模板要求填凭证；填完可点「测试查询」当场验证，保存后自动加入轮询（间隔默认 5 分钟，可在设置里改）。

面板规则：绿 = 正常，黄 = 剩余 < 40%，红 = 查询失败；失败/不支持的渠道自动沉底并被窗口底边遮住（滚动仍可查看）。卡片左侧 ↑↓ 可调整显示顺序。

---

## 一、API 型（填 URL + KEY）

### Kimi Coding Plan

- **前置条件**：开通了 Kimi 的 Coding Plan（月度订阅）
- **凭证**：[Kimi 开放平台](https://platform.kimi.com) 的 API Key
- **填什么**：URL `https://api.kimi.com/coding/v1`（模板自动带出）+ APIKEY
- **显示**：5小时 / 每周 两个计费窗口的剩余百分比与重置时间
- **常见报错**：401 → Key 填错或不是 Coding Plan 的 Key

### GLM Coding Plan（新版 · 个人 / 团队）

- **前置条件**：智谱新版 Coding Plan 订阅（个人或团队 Key）
- **凭证**：[智谱开放平台](https://open.bigmodel.cn) 的 API Key
- **填什么**：URL `https://open.bigmodel.cn/api/coding/paas/v4` + APIKEY（个人/团队二选一模板，查询方式相同）
- **显示**：套餐窗口剩余
- **注意**：老版团队 API 没有额度查询接口（见下方「GLM 老版团队」）

### GLM 老版团队 API（不支持查询）

智谱官方未开放老版团队的额度查询接口（已实测确认）。选这个模板的渠道会常驻显示一段说明；想看百分比需要换用新版 Coding Plan 的 Key。

### DeepSeek 官方

- **凭证**：[DeepSeek 开放平台](https://platform.deepseek.com) 的 API Key
- **填什么**：URL `https://api.deepseek.com` + APIKEY
- **显示**：账户余额（未用金额 / 总充值）
- **可选**：填「总额度」可折算剩余百分比（剩余 = 余额 / 你填的总额度）

### 火山引擎 Coding / Agent Plan

- **前置条件**：火山方舟的 Coding/Agent Plan 订阅
- **凭证**：**不是**推理 API Key——要 IAM「密钥管理」里的 AccessKey / SecretKey；建议建子账号只授 `ArkReadOnlyAccess` 只读权限
- **填什么**：URL（模板自动带出）+ AccessKey + SecretKey 两个框
- **显示**：套餐各窗口剩余
- **常见报错**：「推理 API Key 查不了套餐用量」→ 用错 Key 类型；签名 403 → AK/SK 无 Ark 读权限

### OpenAI 兼容中转站（new-api / one-api 等）

- **凭证**：中转站发给你的 API Key
- **填什么**：URL 填中转站地址（如 `https://xxx.example.com`）+ APIKEY
- **显示**：额度已用/总额（走 `/v1/dashboard/billing/subscription` + `/usage`）
- **常见报错**：部分站点关了计费接口 → 404；可在「自定义端点」里手动指定路径

### 自动检测

不确定站点是什么格式时选这个：按 域名特征 → OpenAI 计费 → DeepSeek 余额 的顺序依次尝试，成功即记住类型。识别不出来再换具体模板或自定义端点。

### 自定义端点

杂牌站兜底：填「查询路径」（如 `/api/usage`）+「字段映射」（点号路径，取 `used` / `total` / `balance` 三个值，例如 `data.used`）。返回 JSON 里任意嵌套层级都能映射。

---

## 二、本机凭证型（零填空，读本地登录态）

这一类**不需要填 URL/KEY**，前提是你在这台机器上登录/使用过对应工具。凭证只在本机读取，只发给对应厂商的官方接口。

### Claude Code / Pro / Max（三路自适应）

按优先级依次尝试，哪路有数据用哪路：

1. **订阅实时查询**（最准）：读 `~/.claude/.credentials.json` 里的 OAuth 凭证，请求 Claude 官方 bootstrap 接口 → 显示 5小时 / 每周 剩余百分比 + 重置时间。前提：Claude Code 里用 claude.ai 订阅 `/login` 登录过
2. **转写统计**（ccusage 方案）：扫描 `~/.claude/projects/**/*.jsonl` 会话转写，把每条 assistant 响应的 token 用量按「间隔 > 5 小时开新块」聚合成当前 5 小时块与 7 天累计。**不需要登录态**，真实用过 Claude Code 就有数据；因为没有官方限额，百分比显示 N/A，标签直接给 token 数
3. **statusline 快照**：读 `~/.claude/usage-status.json`（statusline 工具生成的快照，含精确百分比）

**重要限制**：如果你用 **API 中转**方式跑 Claude Code（设置了 `ANTHROPIC_BASE_URL`），本机没有订阅凭证，只有路径 2 可用；转写也没有就只能看到三路落空的说明。API 按量付费本身没有「订阅额度」概念。

### Codex（本机额度）

- **前置条件**：Codex CLI 以 ChatGPT 账号登录过（`~/.codex/auth.json`）
- **机制（实时优先）**：用本机登录态直查官方额度接口 `chatgpt.com/backend-api/codex/usage`（需代理环境，走系统代理），每轮轮询都是当前值；接口不通/未登录时回退读 `~/.codex/sessions/**/*.jsonl` 里最新一条额度快照（note 会标注「快照」，超过时效再标注「数据截至 M/d HH:mm」）
- **显示**：标签带套餐档（如 `Codex · free`），主窗口（free 档为 30 天月度）剩余百分比 + 重置日
- **说明**：GPT 网页版的用量与 Codex CLI 额度是**两个独立的池子**，网页聊天不会动这张卡；经沙箱运行的 codex（如 AI 工具内委托）消耗额度但不落会话文件——实时接口路径对这类场景是唯一准确的数据源

### Antigravity / Gemini CLI（本机额度）

- **前置条件**：`agy` CLI 登录过（Google 账号 + Antigravity 权益）
- **机制**：按序读取 `~/.gemini/antigravity-cli/antigravity-oauth-token` → Windows 凭据管理器 `gemini:antigravity` 条目 → 必要时用 Google 公开客户端常量刷新 token，再调 Google 官方配额接口
- **显示**：各模型组（Gemini / Claude / GPT 等）的额度窗口
- **注意**：`~/.gemini/oauth_creds.json`（Gemini CLI 直登）的 token 被配额接口拒收，会提示换 agy 登录
- **网络**：Google 域名国内需代理——应用出站请求自动遵循 Windows 系统代理（Clash/v2ray 等的系统代理模式即可，无需 TUN/全局）；报 `fetch failed` 先检查代理是否在跑

### MiniMax Token Plan（本机 mmx CLI）

- **前置条件**：`npm install -g mmx-cli` 且 `mmx auth login`（粘贴 API key 或浏览器登录）
- **机制**：执行 `mmx quota show` 解析各模型组的 5小时/每周窗口剩余
- **常见报错**：`No credentials found` → 先 `mmx auth login`；「未找到 mmx」→ 全局安装 mmx-cli

### 阿里百炼 Coding / Token Plan（本机 bl CLI）

- **前置条件**：`npm install -g bailian-cli` 且 `bl auth login --console`（浏览器登录控制台）
- **机制**：依次执行 `bl usage coding-plan` / `token-plan` / `summary`，显示 5小时/每周/月度 窗口剩余
- **常见报错**：「未登录控制台」→ 控制台会话服务端约 **24 小时**过期（CLI 无续期机制），用量卡片上点「🔑 一键重新登录」会拉起终端跑 `bl auth login --console`，浏览器登录后下一轮轮询自动恢复

### Cursor（本机额度）

- **前置条件**：桌面版 Cursor 已登录
- **机制**：从 `%APPDATA%\Cursor\User\globalStorage\state.vscdb`（SQLite）读出登录 accessToken（纯 Node 页级读取，不引原生依赖，10GB 级库也毫秒级），请求 `api2.cursor.sh/auth/usage-summary`
- **显示**：Auto / API 两个用量池的剩余百分比 + 账单周期重置日，标签显示套餐档（如 Pro）；接口返回绝对值时，组标题显示套餐已用/上限（如 `Pro · 1884/2000`）
- **常见报错**：「登录已过期」→ 在 Cursor 里重新登录；「未开启套餐用量统计」→ 账号没有套餐

---

## 三、通用问题

| 现象 | 原因与解法 |
|---|---|
| 卡片一直灰「等待首次查询」 | 等一个轮询周期，或点面板右上角 ⟳ 立即刷新 |
| 红色 + HTTP 401/403 | KEY 错 / 过期 / 权限不足，回设置核对 |
| 红色 + 超时 | 渠道地址不通或被墙，检查 URL 与网络 |
| 想改显示顺序 | 设置页渠道卡左侧 ↑↓，保存后立即生效 |
| 失败渠道太碍眼 | 会自动沉底并遮在窗口底边下，滚动可查看；彻底不想要就删除该渠道 |
| 面板高度 | 自动贴合正常渠道内容；内容超屏时窗口封顶、卡片区内滚 |
