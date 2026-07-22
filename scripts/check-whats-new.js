/**
 * 校验 package.json 的 version 在 src/shared/whatsNew.ts 中有对应更新说明条目。
 * 发版 / 打包前运行，避免用户端弹窗只有泛化文案。
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = String(pkg.version || '').trim()
const whatsNewPath = path.join(root, 'src/shared/whatsNew.ts')
const src = fs.readFileSync(whatsNewPath, 'utf8')

if (!version) {
  console.error('[check-whats-new] package.json 缺少 version')
  process.exit(1)
}

const escaped = version.replace(/\./g, '\\.')
const hasEntry = new RegExp(`['"]${escaped}['"]\\s*:`).test(src)
if (!hasEntry) {
  console.error(
    `[check-whats-new] package.json version=${version} 在 src/shared/whatsNew.ts 中没有条目。\n` +
      `请在 WHATS_NEW 中增加 '${version}': [ '更新点…' ]`
  )
  process.exit(1)
}

console.log(`[check-whats-new] ok — ${version}`)
