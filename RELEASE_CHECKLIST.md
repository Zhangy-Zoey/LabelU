# 发布检查清单（GitHub Releases）

## 必做

1. **GitHub 账号**
2. **安装并登录 GitHub CLI**

```bash
# Windows（推荐 winget / scoop）或 macOS：brew install gh
gh auth login
```

登录时选择：GitHub.com → HTTPS → 浏览器登录，并勾选 **repo** 权限。

3. **确认仓库**（Public 对 `electron-updater` 最省事）
   - 已配置：https://github.com/Zhangy-Zoey/LabelU
   - `package.json` → `build.publish`：`owner=Zhangy-Zoey`，`repo=LabelU`

4. **发布 Token（二选一）**
   - 推荐：`gh auth login` 后直接发布
   - 或 Personal Access Token（classic，勾选 `repo`）：

```bash
# Windows PowerShell
$env:GH_TOKEN="ghp_xxxxxxxx"

# macOS / Linux
export GH_TOKEN=ghp_xxxxxxxx
```

5. **同步更新说明**
   - 修改 `package.json` 的 `version`（如 `1.2.0`）
   - 在 `src/shared/whatsNew.ts` 的 `WHATS_NEW` 增加**同名**条目
   - `npm run build` / `dist:*` / `release:*` 会自动跑 `check-whats-new`；缺条目会直接失败

## 可选

6. **代码签名**（不做也能装，系统会提示未验证开发者）
   - Windows：代码签名证书（初期可跳过）
   - macOS：当前 **强制不签名**（`identity: null` + `CSC_IDENTITY_AUTO_DISCOVERY=false`），避免误用本机 **Apple Development** 证书导致他机「已损坏/无法打开」
   - 正式分发请换 **Developer ID Application** + 公证（notarize），再去掉 `identity: null` 并开启 `hardenedRuntime`
   - 当前仅打包 **arm64**；未签名时：右键 App →「打开」，或系统设置 → 隐私与安全性 → 仍要打开

## 双平台发版（同一版本号）

每次发版请 **Windows + macOS 都发布到同一个 GitHub Release**：

| 机器 | 命令 | 产物 |
|------|------|------|
| Windows | `npm run release:win` | `.exe`（NSIS）等 + `latest.yml` |
| macOS | `npm run release:mac` | `.dmg` / `.zip` + `latest-mac.yml` |

用户端由 `electron-updater` **只下载当前系统对应的安装包**，不会两个都下。

建议流程：

1. 两边使用**相同** `version`
2. 先在一台机器 `release:*`（会创建 Release）
3. 另一台再 `release:*`（追加同 tag 的产物）
4. 在 GitHub Release 页面核对两套安装包与 yml 是否齐全

## 本地命令

```bash
npm run dev
npm run dist:win
npm run dist:mac
npm run release:win   # 在 Windows 上发布
npm run release:mac   # 在 macOS 上发布
```

## 更新与日志行为

- 客户端更新源为 **generic**（默认国内 GitHub 镜像；可用 `LABELU_UPDATE_URL` / `update-feed-url.txt` 指向 OSS）
- 发版仍上传 GitHub Releases；`npm run release:*` 后可运行 `node scripts/sync-update-feed.js` 查看需同步到 OSS 的文件
- 用户点「下载更新」→「重启安装」：卸旧装新（本平台安装包）
- 首次打开新版本：弹出「更新内容」；异常日志 `exceptions.log` 会被覆盖清空
- 顶栏「查看日志」：打开当前异常日志文件
