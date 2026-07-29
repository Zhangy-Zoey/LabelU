import { app } from 'electron'
import fs from 'fs'
import path from 'path'

/** 所有错误报告发往此邮箱 */
export const ERROR_REPORT_EMAIL = 'fiercetigerr@outlook.com'

const FORM_ENDPOINT = `https://formsubmit.co/ajax/${ERROR_REPORT_EMAIL}`

/** 邮件正文上限（FormSubmit 有体积限制；超出则截断并标注） */
const MAX_LOG_CHARS = 400_000

let lastFingerprints = new Map<string, number>()
let sentThisHour = 0
let hourWindowStart = Date.now()

function fingerprint(tag: string, message: string): string {
  return `${tag}::${message.slice(0, 240)}`
}

function allowSend(tag: string, message: string, force: boolean): boolean {
  if (force) return true
  const now = Date.now()
  if (now - hourWindowStart > 60 * 60 * 1000) {
    hourWindowStart = now
    sentThisHour = 0
  }
  if (sentThisHour >= 30) return false
  const fp = fingerprint(tag, message)
  const prev = lastFingerprints.get(fp) || 0
  if (now - prev < 60_000) return false
  lastFingerprints.set(fp, now)
  if (lastFingerprints.size > 200) {
    const cutoff = now - 10 * 60_000
    lastFingerprints.forEach((t, k) => {
      if (t < cutoff) lastFingerprints.delete(k)
    })
  }
  sentThisHour++
  return true
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 读取整份 exceptions.log；过大则保留末尾并标注 */
function readFullExceptionLog(): { text: string; truncated: boolean; path: string } {
  const file = path.join(app.getPath('userData'), 'logs', 'exceptions.log')
  try {
    if (!fs.existsSync(file)) {
      return { text: '(exceptions.log 不存在或为空)', truncated: false, path: file }
    }
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw.trim()) {
      return { text: '(exceptions.log 为空)', truncated: false, path: file }
    }
    if (raw.length <= MAX_LOG_CHARS) {
      return { text: raw, truncated: false, path: file }
    }
    return {
      text:
        `[截断说明] 日志共 ${raw.length} 字符，邮件仅附末尾 ${MAX_LOG_CHARS} 字符。\n` +
        `完整文件路径: ${file}\n\n` +
        raw.slice(raw.length - MAX_LOG_CHARS),
      truncated: true,
      path: file
    }
  } catch (e) {
    return {
      text: `(读取 exceptions.log 失败: ${e instanceof Error ? e.message : String(e)})`,
      truncated: false,
      path: file
    }
  }
}

let inflightMails: Promise<void>[] = []

export type SendErrorMailOpts = {
  /** 强制发送（跳过去重）；崩溃 / 保存失败等用户可见错误用 */
  force?: boolean
}

/**
 * 将错误报告发到 ERROR_REPORT_EMAIL，并附上整份 exceptions.log。
 */
export async function sendErrorReportEmail(
  tag: string,
  err: unknown,
  extra?: unknown,
  opts?: SendErrorMailOpts
): Promise<void> {
  const message =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const stack = err instanceof Error ? err.stack || '' : ''
  const force = Boolean(opts?.force)
  if (!allowSend(tag, message, force)) return
  if (force) {
    sentThisHour++
  }

  const log = readFullExceptionLog()

  const body = {
    _subject: `[LabelU Video] ${tag}: ${message.slice(0, 80)}`,
    _template: 'table',
    _captcha: 'false',
    app: 'LabelU Video',
    version: (() => {
      try {
        return app.getVersion()
      } catch {
        return ''
      }
    })(),
    platform: `${process.platform} ${process.arch}`,
    time: new Date().toISOString(),
    tag,
    message,
    stack,
    extra: extra === undefined ? '' : safeJson(extra),
    exceptionLogPath: log.path,
    exceptionLogTruncated: log.truncated ? 'yes' : 'no',
    /** 整份 error 日志（过大时为末尾） */
    exceptionLog: log.text
  }

  const job = (async () => {
    try {
      const res = await fetch(FORM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: 'https://labelu.app',
          Referer: 'https://labelu.app/'
        },
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        try {
          process.stderr.write(
            `[labelu] error-mail failed: ${res.status} ${text.slice(0, 200)}\n`
          )
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      try {
        process.stderr.write(`[labelu] error-mail error: ${String(e)}\n`)
      } catch {
        /* ignore */
      }
    }
  })()

  inflightMails.push(job)
  try {
    await job
  } finally {
    inflightMails = inflightMails.filter((p) => p !== job)
  }
}

/** 同步触发异步发送，不阻塞调用方 */
export function captureMainError(
  tag: string,
  err: unknown,
  extra?: unknown,
  opts?: SendErrorMailOpts
): void {
  void sendErrorReportEmail(tag, err, extra, opts)
}

/** 兼容旧 init 调用点：邮件上报无需预初始化 */
export function initMainSentry(): void {
  /* no-op：已改为邮件上报 */
}

/** 进程退出前等待 in-flight 邮件（有超时） */
export async function flushErrorReports(timeoutMs = 2000): Promise<void> {
  const pending = [...inflightMails]
  if (pending.length === 0) return
  await Promise.race([
    Promise.allSettled(pending).then(() => undefined),
    new Promise<void>((r) => setTimeout(r, timeoutMs))
  ])
}
