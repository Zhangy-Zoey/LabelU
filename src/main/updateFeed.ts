import fs from 'fs'
import path from 'path'
import { app } from 'electron'

/**
 * 客户端检查/下载更新的 generic 源（须以 / 结尾）。
 * 默认走国内可访问的 GitHub Release 镜像；有对象存储时用 LABELU_UPDATE_URL
 * 或 userData/update-feed-url.txt 覆盖为你的 CDN/OSS 目录（内含 latest.yml / latest-mac.yml 与安装包）。
 */
export const DEFAULT_UPDATE_FEED_URL =
  'https://ghfast.top/https://github.com/Zhangy-Zoey/LabelU/releases/latest/download/'

function ensureTrailingSlash(url: string): string {
  const u = url.trim()
  if (!u) return u
  return u.endsWith('/') ? u : `${u}/`
}

/** 解析更新源：环境变量 > userData 覆盖文件 > 默认国内镜像 */
export function resolveUpdateFeedUrl(): string {
  const fromEnv = String(process.env.LABELU_UPDATE_URL || '').trim()
  if (fromEnv) return ensureTrailingSlash(fromEnv)

  try {
    const overridePath = path.join(app.getPath('userData'), 'update-feed-url.txt')
    if (fs.existsSync(overridePath)) {
      const fromFile = fs.readFileSync(overridePath, 'utf8').split(/\r?\n/)[0]?.trim() || ''
      if (fromFile) return ensureTrailingSlash(fromFile)
    }
  } catch {
    /* ignore */
  }

  return DEFAULT_UPDATE_FEED_URL
}
