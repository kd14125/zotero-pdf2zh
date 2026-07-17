# PDF2ZH Desktop

PDF2ZH Desktop 是 `zotero-pdf2zh` 的独立 Windows 客户端。它直接管理官方
`PDFMathTranslate-next` Windows 运行时，不依赖 Zotero、Python、uv 或 conda。

## 开发

要求 Node.js 22 及 Windows 10/11 x64。

```powershell
npm install --ignore-scripts
npm run dev
```

`node-pty` 已包含 Windows x64 ConPTY 预编译模块，项目关闭了 electron-builder 的原生重建。

## MCP 架构

安装包同时包含桌面界面、隐藏翻译引擎和 `stdio` MCP 服务。桌面端与 MCP 通过当前 Windows
用户专属的命名管道连接同一个引擎，由引擎独占配置、历史、运行时和任务队列。关闭桌面窗口不会
终止 MCP 发起的任务。

设置页可显式调用 `codex mcp add` 接入 `pdf2zh-desktop`，并提供重新检测、取消接入和复制手动
配置。安装程序不会静默修改 Codex 配置。MCP 不开放 HTTP 端口，也不提供 API Key 读取、修改
或删除结果文件的工具。

## 验证和打包

```powershell
npm run verify
npm run build
npm run test:ui
npm run package
```

MCP 构建会将稳定版 `@modelcontextprotocol/sdk`、Zod 校验和纯 Node 引擎客户端打包为
`build/mcp/server.cjs`，并附带独立的 `pdf2zh-mcp.exe`，用户不需要另外安装 Node.js。

安装包生成在 `desktop/release/`。安装包不包含约 630 MB 的翻译运行时；首次启动由运行时页面
下载固定版本、校验 SHA-256 后解压到用户数据目录。后续桌面应用更新会扫描并复用已有运行时，
包括缺少 `current.json` 或位于旧版用户数据目录的完整安装。

SiliconFlowFree 会自动追加 `--disable-rich-text-translate`，避免服务将 PDF2ZH 内部富文本标签
翻译进正文。

## 数据与密钥

- 应用配置：`%APPDATA%/PDF2ZH Desktop`
- 翻译运行时：`%LOCALAPPDATA%/PDF2ZH Desktop/runtime`
- API Key：Electron `safeStorage` / Windows DPAPI 加密
- 翻译结果：默认位于原 PDF 旁的 `PDF2ZH-翻译结果`

每条翻译服务配置使用独立 ID 保存 API Key、Base URL 和模型，可在设置页左侧列表中切换。
模型字段支持手动输入；通过当前配置获取模型后，全部结果会显示在独立下拉框中供选择。

Anthropic Messages 配置通过引擎内的短生命周期本地适配器转换为 PDF2ZH 所需的 OpenAI
Chat Completions 格式。适配器仅监听 `127.0.0.1`，使用随机的任务级本地凭据；真实 API Key
只保留在引擎内存和 DPAPI 加密存储中，不写入任务 TOML。

OpenAI Compatible 配置同样通过本机回环适配器转发。根地址会自动补全 `/v1`，并在转发前
移除 `openai-python` 自动添加、可能被部分中转站 WAF 拦截的 `User-Agent` 和
`X-Stainless-*` 请求头。请求正文和标准 OpenAI Chat Completions 响应保持不变。

应用更新使用 `electron-updater` 和 GitHub Release。Release 必须同时包含安装包、`latest.yml`
和 `.blockmap`；用户在设置页手动检查、下载并确认重启安装，不执行静默更新。

任务执行时会创建短生命周期 TOML 配置，完成、失败或取消后均删除。日志和历史记录不会保存
API Key。

## 许可证

本项目与上游均使用 AGPL-3.0 系列许可证。运行时对应源码版本和许可证入口可在应用设置及
`runtime-manifest.json` 中查看。
