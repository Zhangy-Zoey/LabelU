#!/usr/bin/env node
/**
 * 发版后把 release/ 下的更新元数据与安装包同步说明 / 可选上传。
 *
 * 默认客户端更新源（generic）：
 *   https://ghfast.top/https://github.com/Zhangy-Zoey/LabelU/releases/latest/download/
 * 继续用 `npm run release:mac|win` 发到 GitHub 即可被镜像拉取。
 *
 * 若自建 OSS/CDN（推荐稳定生产）：
 * 1. 把下列文件放到公开目录（与 LABELU_UPDATE_URL 一致，须可读）：
 *      latest.yml
 *      latest-mac.yml
 *      LabelU-Video-Setup-*.exe (+ .blockmap 可选)
 *      LabelU-Video-*-arm64.zip (+ .blockmap 可选)
 * 2. 构建/运行前设置：
 *      export LABELU_UPDATE_URL="https://your-bucket.oss-cn-hangzhou.aliyuncs.com/labelu/"
 *    或在用户机 userData 写入 update-feed-url.txt
 * 3. 可选：本脚本在设置 LABELU_UPDATE_RSYNC / 自定义上传命令时执行同步
 *
 * 用法：
 *   node scripts/sync-update-feed.js          # 打印待同步文件
 *   LABELU_UPDATE_UPLOAD_CMD='...' node scripts/sync-update-feed.js  # 对每个文件执行上传命令（{file} {name}）
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const releaseDir = path.join(root, 'release')

const needed = []
for (const name of fs.readdirSync(releaseDir)) {
  if (
    /^(latest\.yml|latest-mac\.yml)$/.test(name) ||
    /^LabelU-Video-Setup-.*\.exe(\.blockmap)?$/.test(name) ||
    /^LabelU-Video-.*-arm64\.(zip|dmg)(\.blockmap)?$/.test(name)
  ) {
    needed.push(name)
  }
}

needed.sort()
console.log('[sync-update-feed] release artifacts:')
for (const name of needed) {
  const full = path.join(releaseDir, name)
  const size = fs.statSync(full).size
  console.log(`  - ${name} (${size} bytes)`)
}

const feed =
  process.env.LABELU_UPDATE_URL ||
  'https://ghfast.top/https://github.com/Zhangy-Zoey/LabelU/releases/latest/download/'
console.log(`[sync-update-feed] client feed URL: ${feed.replace(/\/*$/, '/')}`)

const uploadCmd = process.env.LABELU_UPDATE_UPLOAD_CMD || ''
if (!uploadCmd) {
  console.log(
    '[sync-update-feed] GitHub Release 已足够（默认镜像会拉 latest/download）。\n' +
      '  若用自建 OSS：上传上述文件后设置 LABELU_UPDATE_URL，并重新打包客户端。\n' +
      '  批量上传示例：LABELU_UPDATE_UPLOAD_CMD=\'ossutil cp {file} oss://bucket/labelu/{name}\' node scripts/sync-update-feed.js'
  )
  process.exit(0)
}

let failed = 0
for (const name of needed) {
  const file = path.join(releaseDir, name)
  const cmd = uploadCmd.replaceAll('{file}', file).replaceAll('{name}', name)
  console.log(`[sync-update-feed] $ ${cmd}`)
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit' })
  if (r.status !== 0) failed++
}
process.exit(failed ? 1 : 0)
