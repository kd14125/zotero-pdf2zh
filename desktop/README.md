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

## 验证和打包

```powershell
npm run verify
npm run build
npm run test:ui
npm run package
```

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

应用更新使用 `electron-updater` 和 GitHub Release。Release 必须同时包含安装包、`latest.yml`
和 `.blockmap`；用户在设置页手动检查、下载并确认重启安装，不执行静默更新。

任务执行时会创建短生命周期 TOML 配置，完成、失败或取消后均删除。日志和历史记录不会保存
API Key。

## 许可证

本项目与上游均使用 AGPL-3.0 系列许可证。运行时对应源码版本和许可证入口可在应用设置及
`runtime-manifest.json` 中查看。
