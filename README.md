# LabelU Video

Windows / macOS 桌面应用：视频时间裁剪、画面裁切、按类别打标导出。

界面与快捷键说明统一按 **Windows** 习惯书写（Ctrl）；在 macOS 上 Ctrl 对应系统的 Command 键操作仍可用。

## 开发

```bash
npm install
npm run dev
```

## 打包

```bash
npm run dist:win   # Windows x64（nsis / portable）
npm run dist:mac   # macOS Apple Silicon（arm64 dmg/zip）
```

当前 mac 包仅为 **Apple Silicon**；Intel Mac 需自行改构建脚本加 `--x64`。安装包默认未签名：Windows 可能 SmartScreen 提示，macOS 可能 Gatekeeper 拦截（右键打开或系统设置里允许）。

## 发布到 GitHub Releases

1. 确认 `package.json` → `build.publish` 的 GitHub `owner` / `repo`
2. 修改 `version`，并在 `src/shared/whatsNew.ts` 增补该版本更新说明
3. 设置 `GH_TOKEN`（需 `repo` 权限）或 `gh auth login`
4. **同一 version** 分别在两台机器发布（用户端只会下载本平台安装包）：

```bash
npm run release:win   # Windows：上传 Setup.exe + latest.yml
npm run release:mac   # macOS：上传 dmg/zip + latest-mac.yml
```

详见 `RELEASE_CHECKLIST.md`。

## 快捷键（Windows 描述）

| 操作 | 快捷键 |
|------|--------|
| 保存片段 | Enter / 点击「保存片段」 |
| 确认分类 | 保存弹窗内 Enter |
| 撤回 | Ctrl+Z（优先保存 → 批量 → 选区；批量也可用「撤回批量」） |
| 选区循环播放 | Space（「循环开」时到出点后重播） |
| 添加时间轴标记 | M |
| 清除全部标记 | Alt+M（可撤回） |
| 删除单个标记 | 单击标记（可撤回） |
| 播放/暂停 | Space |
| 上一个 / 下一个视频 | ← / → |
| 微调选区 | 微调模式下 ← / → |
| 设入点 / 出点 | [ / ] |
| 多选视频 | Ctrl+单击 |
| 连选视频 | Shift+单击 |
| 缩放缩略图 | Ctrl+滚轮 |
| 退出编辑 | Esc |
