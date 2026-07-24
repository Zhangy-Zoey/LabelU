/** 等待视频真正解出至少一帧；超时视为解码失败（Win HEVC 黑屏常不触发 error） */
export function waitForDecodedFrame(
  video: HTMLVideoElement,
  timeoutMs = 2200
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let gotFrameCb = false
    const t0 = Number.isFinite(video.currentTime) ? video.currentTime : 0
    const legacyTimers: number[] = []

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      for (const id of legacyTimers) window.clearTimeout(id)
      video.removeEventListener('loadeddata', onProgress)
      video.removeEventListener('playing', onProgress)
      video.removeEventListener('seeked', onProgress)
      video.removeEventListener('loadeddata', legacyCheck)
      video.removeEventListener('playing', legacyCheck)
      resolve(ok)
    }

    const looksReady = (): boolean =>
      video.videoWidth > 1 && video.videoHeight > 1 && video.readyState >= 2

    const onProgress = (): void => {
      if (gotFrameCb && looksReady()) finish(true)
    }

    const legacyCheck = (): void => {
      if (looksReady() && video.readyState >= 3) {
        gotFrameCb = true
        finish(true)
      }
    }

    const timer = window.setTimeout(() => {
      if (gotFrameCb && looksReady()) {
        finish(true)
        return
      }
      // 无帧回调时：播放中时间前进且有画面尺寸，才算成功（避免黑屏占位）
      const advanced = !video.paused && video.currentTime > t0 + 0.1
      finish(advanced && looksReady())
    }, timeoutMs)

    const rvfc = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number
      }
    ).requestVideoFrameCallback

    if (typeof rvfc === 'function') {
      rvfc.call(video, () => {
        gotFrameCb = true
        if (looksReady()) finish(true)
      })
    } else {
      video.addEventListener('loadeddata', legacyCheck)
      video.addEventListener('playing', legacyCheck)
      legacyTimers.push(window.setTimeout(legacyCheck, 400))
      legacyTimers.push(window.setTimeout(legacyCheck, 1000))
    }

    video.addEventListener('loadeddata', onProgress)
    video.addEventListener('playing', onProgress)
    video.addEventListener('seeked', onProgress)
    onProgress()
  })
}

/** HEVC 家族：优先硬解，失败再强制 H.264 代理 */
export function codecMayNeedProxyFallback(codecName: string | undefined | null): boolean {
  if (!codecName) return false
  const c = codecName.toLowerCase()
  return c.includes('hevc') || c.includes('h265') || c.includes('hev1') || c.includes('hvc1')
}
