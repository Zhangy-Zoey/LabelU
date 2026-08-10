/**
 * 轻量导出队列：保存请求串行执行，关闭弹窗后可继续排队。
 */

export type ExportQueueJob<T = void> = {
  id: string
  label: string
  run: () => Promise<T>
}

type Listener = (state: {
  active: boolean
  pending: number
  currentLabel: string | null
}) => void

let chain: Promise<void> = Promise.resolve()
let pending = 0
let currentLabel: string | null = null
/** 递增后，尚未开始的排队任务会跳过 */
let clearEpoch = 0
const listeners = new Set<Listener>()

function emit(): void {
  const snap = {
    active: pending > 0 || currentLabel != null,
    /** 尚未开始的等待数（不含当前正在跑的） */
    pending: currentLabel != null ? Math.max(0, pending - 1) : pending,
    currentLabel
  }
  listeners.forEach((cb) => {
    try {
      cb(snap)
    } catch {
      /* ignore */
    }
  })
}

export function subscribeExportQueue(cb: Listener): () => void {
  listeners.add(cb)
  cb({
    active: pending > 0 || currentLabel != null,
    pending: currentLabel != null ? Math.max(0, pending - 1) : pending,
    currentLabel
  })
  return () => listeners.delete(cb)
}

export function enqueueExportJob<T>(job: ExportQueueJob<T>): Promise<T> {
  const epoch = clearEpoch
  pending++
  emit()
  const done = chain.then(async () => {
    if (epoch !== clearEpoch) {
      // pending 已在 clearPendingExportJobs 里扣过
      throw new Error('导出队列已取消')
    }
    currentLabel = job.label
    emit()
    try {
      return await job.run()
    } finally {
      pending = Math.max(0, pending - 1)
      currentLabel = null
      emit()
    }
  })
  chain = done.then(
    () => undefined,
    () => undefined
  )
  return done
}

/**
 * 丢弃尚未开始的排队任务；正在执行的当前任务不受影响（需配合 cancelBusyWork 中止）。
 * @returns 被丢弃的等待任务数
 */
export function clearPendingExportJobs(): number {
  const waiting = currentLabel != null ? Math.max(0, pending - 1) : pending
  if (waiting <= 0) return 0
  clearEpoch++
  pending = currentLabel != null ? 1 : 0
  emit()
  return waiting
}
