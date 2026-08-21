# NOTICE — 重要声明

本项目代码以 MIT 许可发布，但以下事项请使用者特别注意：

## 1. 默认角色素材没有开源许可证

`assets/spritesheet.webp`（鲸鱼娘精灵图）来自
[richray666/deepseek-whale-girl-codex-pet](https://github.com/richray666/deepseek-whale-girl-codex-pet)，
该仓库**未附带任何开源许可证**。因此：

- 仅限**个人桌面使用**，请勿再分发该素材或基于它发布衍生作品
- 如果你要公开分发本项目或其打包产物，请先取得原作者授权，或自行更换为可商用/开源素材
- 可替换方案：按 [docs/characters.md](docs/characters.md) 的格式自制角色包

## 2. 与 aqua5230/usage 的关系

部分本机 CLI 额度的**数据格式**（JSON 字段名、文件位置）参考了社区项目
[aqua5230/usage](https://github.com/aqua5230/usage)（AGPL-3.0）的公开行为。
本项目为**独立实现**，未复制、未链接其任何代码；本项目整体不以 AGPL 发布。
若你对其许可有顾虑，请自行审查相关适配器（main/quota/local-clis.js）。

## 3. 非官方接口的风险

以下查询走的是各家**未公开/非官方承诺**的接口或本地数据，厂商改版后可能随时失效：

| 渠道 | 依赖 |
|---|---|
| Claude Code | `api.claude.ai/api/bootstrap`（订阅 OAuth 凭证）+ 本地转写扫描 |
| Cursor | `api2.cursor.sh/auth/usage-summary`（本地 state.vscdb 里的登录凭证） |
| Antigravity / Gemini CLI | Google 内部配额接口 `daily-cloudcode-pa.googleapis.com` |
| Codex | 本地 `~/.codex/sessions` 里的官方额度记录 |
| MiniMax / 百炼 | 各家官方 CLI 的输出格式 |

失效时卡片会显示具体报错。欢迎提 issue，适配会跟进。

## 4. 凭证安全

- 你填写的 APIKEY 经 Windows DPAPI（Electron safeStorage）加密后存于本地 `%APPDATA%\ai-volume-pet\config.json`
- 本机凭证型渠道读取的登录数据（Cursor state.vscdb、Claude credentials 等）**只在本机内存中使用**，且只发送给对应厂商自己的官方接口
- 本项目不做任何统计、遥测或第三方上报
