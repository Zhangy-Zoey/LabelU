import { useEffect, useRef, useState } from 'react'
import { codecMayNeedProxyFallback, waitForDecodedFrame } from './playbackHealth'

const MOD_KEY = /Mac|Macintosh/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'

type Props = {
  id: string
  path: string
  name: string
  parentDirName: string
  completed: boolean
  active: boolean
  selected: boolean
  /** 二次选中（批量分类目标） */
  secondaryPicked?: boolean
  /** 二次选择模式开启 */
  secondaryMode?: boolean
  /** 由父组件控制：是否正在小窗预览 */
  previewActive: boolean
  isCategoryCopy?: boolean
  mediaKind?: 'video' | 'image'
  disabled?: boolean
  onOpen: () => void
  /** 双击打开主预览（不改选中） */
  onActivate?: () => void
  onToggleSelect: () => void
  onRangeSelect: () => void
  /** 点击播放键：父组件决定单播或多选同播 */
  onPlayClick: () => void
}

export function VideoThumb({
  id,
  path,
  name,
  parentDirName,
  completed,
  active,
  selected,
  secondaryPicked,
  secondaryMode,
  previewActive,
  isCategoryCopy,
  mediaKind,
  disabled,
  onOpen,
  onActivate,
  onToggleSelect,
  onRangeSelect,
  onPlayClick
}: Props): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const scrubRef = useRef<HTMLDivElement>(null)
  const scrubbingRef = useRef(false)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewTime, setPreviewTime] = useState(0)
  const [previewDuration, setPreviewDuration] = useState(0)
  /** macOS 等：原片 HEVC 播失败后强制走 H.264 代理 */
  const proxyForcedRef = useRef(false)
  const decodeWatchGenRef = useRef(0)
  const previewing = previewActive && Boolean(previewUrl)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let cancelled = false
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        io.disconnect()
        void window.api
          .getThumbnail(path)
          .then((result: { url: string; width: number; height: number } | string) => {
            if (cancelled) return
            setSrc(typeof result === 'string' ? result : result.url)
          })
          .catch(() => {
            if (!cancelled) setFailed(true)
          })
      },
      { rootMargin: '160px' }
    )
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
    }
  }, [path])

  const stopPreviewMedia = (): void => {
    decodeWatchGenRef.current++
    const v = videoRef.current
    if (v) {
      try {
        v.pause()
        v.removeAttribute('src')
        v.load()
      } catch {
        /* ignore */
      }
    }
    setPreviewUrl(null)
    setPreviewTime(0)
    setPreviewDuration(0)
    scrubbingRef.current = false
  }

  const retryWithForcedProxy = (): void => {
    if (proxyForcedRef.current || !previewActive) return
    proxyForcedRef.current = true
    const watchGen = ++decodeWatchGenRef.current
    void (async () => {
      try {
        const proxy = await window.api.ensurePreviewProxy(path, true, true)
        if (watchGen !== decodeWatchGenRef.current || !previewActive) return
        setPreviewUrl(proxy.url)
        setPreviewTime(0)
        setPreviewDuration(0)
        requestAnimationFrame(() => {
          if (watchGen !== decodeWatchGenRef.current) return
          const v = videoRef.current
          if (!v) return
          v.muted = true
          v.currentTime = 0
          void v.play().catch(() => undefined)
        })
      } catch {
        if (watchGen !== decodeWatchGenRef.current) return
        proxyForcedRef.current = false
        stopPreviewMedia()
      }
    })()
  }

  // 父组件控制开/关小窗预览
  useEffect(() => {
    let cancelled = false
    proxyForcedRef.current = false
    decodeWatchGenRef.current++
    if (!previewActive) {
      stopPreviewMedia()
      return
    }
    void (async () => {
      try {
        // 无 force：有缓存代理则复用，否则原片。quiet 不抢全局 busy
        const proxy = await window.api.ensurePreviewProxy(path, false, true)
        if (cancelled) return
        setPreviewUrl(proxy.url)
        setPreviewTime(0)
        setPreviewDuration(0)
        const alreadyProxied = proxy.proxied
        if (alreadyProxied) proxyForcedRef.current = true
        const watchGen = ++decodeWatchGenRef.current
        requestAnimationFrame(() => {
          if (cancelled) return
          const v = videoRef.current
          if (!v) return
          v.muted = true
          v.currentTime = 0
          void v.play().catch(() => undefined)
          if (alreadyProxied) return
          // 仅对可能需代理的编码做黑屏看门狗，避免 H.264 慢加载误转码
          void (async () => {
            let mayNeed = false
            try {
              const probe = await window.api.probe(path)
              mayNeed = codecMayNeedProxyFallback(probe.videoCodec)
            } catch {
              mayNeed = false
            }
            if (cancelled || watchGen !== decodeWatchGenRef.current || !mayNeed) return
            const ok = await waitForDecodedFrame(v, 2200)
            if (cancelled || watchGen !== decodeWatchGenRef.current) return
            if (!ok) retryWithForcedProxy()
          })()
        })
      } catch {
        if (!cancelled) stopPreviewMedia()
      }
    })()
    return () => {
      cancelled = true
    }
    // path 变化时由父级关掉 previewActive 或重开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewActive, path])

  useEffect(
    () => () => {
      stopPreviewMedia()
    },
    [path]
  )

  const seekFromClientX = (clientX: number): void => {
    const bar = scrubRef.current
    const v = videoRef.current
    if (!bar || !v) return
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : previewDuration
    if (!(dur > 0)) return
    const rect = bar.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)))
    const t = ratio * dur
    try {
      v.currentTime = t
    } catch {
      /* ignore */
    }
    setPreviewTime(t)
  }

  const startScrub = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!previewing || disabled) return
    scrubbingRef.current = true
    seekFromClientX(e.clientX)
    const move = (ev: MouseEvent): void => {
      if (!scrubbingRef.current) return
      seekFromClientX(ev.clientX)
    }
    const up = (): void => {
      scrubbingRef.current = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const v = videoRef.current
      if (v && v.paused) void v.play().catch(() => undefined)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const isImage = mediaKind === 'image'

  const progressPct =
    previewDuration > 0 ? Math.min(100, Math.max(0, (previewTime / previewDuration) * 100)) : 0

  return (
    <div
      ref={rootRef}
      data-video-id={id}
      className={`video-thumb ${active ? 'active' : ''} ${completed ? 'completed' : ''} ${selected ? 'selected' : ''} ${secondaryPicked ? 'secondary-picked' : ''} ${previewing ? 'previewing' : ''}`}
      title={
        secondaryMode
          ? `${name}
二次选择中：单击已选卡片切换是否纳入批量分类；可拖选
不改主选中 · 不打断播放 · 双击打开主预览
${MOD_KEY}+单击仍可加减主选中`
          : `${name}
选中：单击打开 · ${MOD_KEY}+单击加减 · Shift+连选 · 按住拖选
小窗：点播放键开/关（可叠加；多选时点其一可同播全部选中）
多选后可开「二次选择」再挑分类目标`
      }
      onMouseDown={(e) => {
        if (disabled) return
        if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault()
      }}
      onClick={(e) => {
        if (disabled) return
        if (e.shiftKey) {
          e.preventDefault()
          onRangeSelect()
          return
        }
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault()
          onToggleSelect()
          return
        }
        onOpen()
      }}
      onDoubleClick={(e) => {
        if (disabled) return
        if (e.shiftKey || e.metaKey || e.ctrlKey) return
        e.preventDefault()
        onActivate?.()
      }}
    >
      <div className="thumb-media">
        {previewing && previewUrl ? (
          <video
            ref={videoRef}
            className="thumb-preview-video"
            src={previewUrl}
            muted
            playsInline
            loop
            draggable={false}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration
              if (Number.isFinite(d) && d > 0) setPreviewDuration(d)
            }}
            onTimeUpdate={(e) => {
              if (scrubbingRef.current) return
              setPreviewTime(e.currentTarget.currentTime)
            }}
            onError={() => {
              // macOS 等：系统 HEVC 解码失败时强制 H.264 代理回退
              retryWithForcedProxy()
            }}
          />
        ) : src && !failed ? (
          <img src={src} alt="" draggable={false} />
        ) : (
          <div className="thumb-placeholder">{failed ? '无预览' : '加载中'}</div>
        )}
        {!isImage && (
          <button
            type="button"
            className={`thumb-play-btn ${previewing ? 'playing' : ''}`}
            title={
              previewing
                ? '停止此条小窗（其它继续播）'
                : selected
                  ? '小窗播放：可叠加；多选时点其一将同播全部选中'
                  : '小窗播放（可叠加）'
            }
            disabled={disabled}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onPlayClick()
            }}
          >
            {previewing ? (
              <span className="thumb-play-pause" aria-hidden />
            ) : (
              <span className="thumb-play-triangle" aria-hidden />
            )}
          </button>
        )}
        {previewing && !isImage && (
          <div
            ref={scrubRef}
            className="thumb-scrub"
            role="slider"
            aria-label="预览进度"
            aria-valuemin={0}
            aria-valuemax={Math.round(previewDuration) || 0}
            aria-valuenow={Math.round(previewTime)}
            title="拖拽进度"
            onClick={(e) => {
              if (e.shiftKey || e.metaKey || e.ctrlKey) return
              e.preventDefault()
              e.stopPropagation()
            }}
            onMouseDown={(e) => {
              if (e.shiftKey || e.metaKey || e.ctrlKey) {
                e.preventDefault()
                return
              }
              startScrub(e)
            }}
          >
            <div className="thumb-scrub-track">
              <div className="thumb-scrub-fill" style={{ width: `${progressPct}%` }} />
              <div className="thumb-scrub-thumb" style={{ left: `${progressPct}%` }} />
            </div>
          </div>
        )}
        {secondaryMode && selected && (
          <span
            className={`thumb-badge pick ${secondaryPicked ? 'on' : ''}`}
            title="单击切换是否纳入批量分类"
          >
            {secondaryPicked ? '二次已选' : '点选分类'}
          </span>
        )}
        {active && (
          <span className="thumb-badge current" title="当前正在编辑">
            当前
          </span>
        )}
        {isCategoryCopy ? (
          <span className="thumb-badge copy" title="位于类别子目录">
            已归类
          </span>
        ) : (
          completed && <span className="thumb-badge">完成</span>
        )}
      </div>
      <div className="thumb-caption">
        <div className="name">{name}</div>
        <div className="meta">{parentDirName}</div>
      </div>
    </div>
  )
}
