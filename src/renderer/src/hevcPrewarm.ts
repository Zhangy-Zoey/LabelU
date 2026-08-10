import { codecMayNeedProxyFallback } from './playbackHealth'

type PrewarmApi = {
  probe: (path: string) => Promise<{ videoCodec?: string; needsPreviewProxy?: boolean }>
  ensurePreviewProxy: (path: string, force?: boolean, quiet?: boolean) => Promise<unknown>
}

let cancelled = false
let runId = 0
let running: Promise<void> | null = null

/** 取消当前预热队列（切换工作区 / 关闭开关 / 开始导出时） */
export function cancelHevcPrewarm(): void {
  cancelled = true
  runId++
}

/**
 * 导入后后台为可能需代理的视频生成兼容预览（quiet，不抢 busy UI）。
 * 并发 1；新任务会取消并等待旧任务结束后再跑。
 */
export function startHevcPrewarm(
  api: PrewarmApi,
  paths: string[],
  opts?: { onProgress?: (msg: string) => void }
): void {
  cancelHevcPrewarm()
  const id = ++runId
  cancelled = false
  const list = Array.from(new Set(paths.filter(Boolean)))
  if (list.length === 0) return

  const prev = running
  const job = (async () => {
    if (prev) {
      try {
        await prev
      } catch {
        /* ignore */
      }
    }
    if (cancelled || id !== runId) return

    let i = 0
    for (const p of list) {
      if (cancelled || id !== runId) break
      i++
      try {
        const probe = await api.probe(p)
        if (cancelled || id !== runId) break
        const need =
          Boolean(probe?.needsPreviewProxy) ||
          codecMayNeedProxyFallback(probe?.videoCodec || '')
        if (!need) continue
        opts?.onProgress?.(`预热预览 ${i}/${list.length}`)
        // force=true：无缓存时真正生成代理（false 只会复用已有缓存）
        await api.ensurePreviewProxy(p, true, true)
      } catch {
        /* 预热失败不影响主流程 */
      }
    }
    if (id === runId) opts?.onProgress?.('')
  })()

  running = job.finally(() => {
    if (running === job) running = null
  })
}
