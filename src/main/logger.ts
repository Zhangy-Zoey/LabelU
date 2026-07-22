import fs from 'fs'
import path from 'path'
import { app } from 'electron'

let initialized = false

const EXCEPTION_LOG_NAME = 'exceptions.log'

function logDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function ensureLogDir(): void {
  fs.mkdirSync(logDir(), { recursive: true })
}

/** 唯一的异常日志文件路径（所有异常写入同一文件） */
export function getExceptionLogPath(): string {
  return path.join(logDir(), EXCEPTION_LOG_NAME)
}

export function getLogDir(): string {
  return logDir()
}

/** 覆盖清空异常日志，并删除旧版按日滚动的日志文件 */
export function clearExceptionLog(_reason = 'cleared'): void {
  try {
    ensureLogDir()
    // 异常日志保持空文件；不写 info 头，避免「新安装就有日志」的误解
    fs.writeFileSync(getExceptionLogPath(), '', 'utf8')
    for (const name of fs.readdirSync(logDir())) {
      if (/^labelu-\d{4}-\d{2}-\d{2}\.log$/i.test(name)) {
        try {
          fs.unlinkSync(path.join(logDir(), name))
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* 日志失败不得影响主流程 */
  }
}

/** 用户数据目录下单一异常日志 */
export function initLogger(): void {
  try {
    ensureLogDir()
    initialized = true
    // 启动信息不写入异常日志，避免冲淡异常内容；仅确保文件存在
    if (!fs.existsSync(getExceptionLogPath())) {
      fs.writeFileSync(getExceptionLogPath(), '', 'utf8')
    }
  } catch {
    initialized = false
  }
}

/**
 * 追加日志。异常日志只收录 warn/error；info 默认忽略（避免污染）。
 * 需要诊断信息时可传 force: true。
 */
export function appendLog(
  level: 'info' | 'warn' | 'error',
  tag: string,
  message: string,
  extra?: unknown,
  opts?: { force?: boolean }
): void {
  try {
    if (level === 'info' && !opts?.force) return
    if (!initialized) {
      try {
        ensureLogDir()
        initialized = true
      } catch {
        return
      }
    }
    const file = getExceptionLogPath()
    const extraText = extra === undefined ? '' : ` ${safeJson(extra)}`
    const line = `${new Date().toISOString()} [${level}] [${tag}] ${message}${extraText}\n`
    fs.appendFileSync(file, line, 'utf8')
  } catch {
    /* 日志失败不得影响主流程 */
  }
}

export function logError(tag: string, err: unknown, extra?: unknown): void {
  const message =
    err instanceof Error
      ? `${err.name}: ${err.message}\n${err.stack || ''}`
      : String(err)
  appendLog('error', tag, message, extra)
}
