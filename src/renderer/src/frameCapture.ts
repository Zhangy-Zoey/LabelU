/** 从已 seek 的 video 抓一帧为 JPEG dataURL（高清，供选区帧条） */
export async function seekAndCaptureFrame(
  video: HTMLVideoElement,
  time: number,
  width = 360
): Promise<string> {
  await seekVideo(video, time)
  const vw = video.videoWidth || 160
  const vh = video.videoHeight || 90
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1
  const targetW = Math.round(width * dpr)
  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = Math.max(1, Math.round((targetW * vh) / vw))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.92)
}

/** 可靠 seek：带超时，避免 media 协议偶发不触发 seeked 导致永久挂起 */
export function seekVideo(video: HTMLVideoElement, time: number, timeoutMs = 800): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(time)) {
      reject(new Error('invalid time'))
      return
    }
    const target = Math.max(0, time)
    let settled = false
    const finish = (ok: boolean, err?: Error): void => {
      if (settled) return
      settled = true
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      window.clearTimeout(timer)
      if (ok) resolve()
      else reject(err || new Error('seek failed'))
    }
    const onSeeked = (): void => finish(true)
    const onError = (): void => finish(false, new Error('seek error'))
    const timer = window.setTimeout(() => finish(true), timeoutMs)

    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    try {
      // 已在目标附近也强制写一次，确保解码器刷新
      if (Math.abs(video.currentTime - target) < 0.0005) {
        video.currentTime = target < 0.05 ? target + 0.001 : target - 0.001
      }
      video.currentTime = target
    } catch (err) {
      finish(false, err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/** 以中心帧为优先，再向两侧扩展的索引顺序 */
export function filmstripOrder(radius: number): number[] {
  const order = [0]
  for (let i = 1; i <= radius; i++) {
    order.push(-i, i)
  }
  return order
}
