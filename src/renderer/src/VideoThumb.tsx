import { useEffect, useRef, useState } from 'react'

const MOD_KEY = /Mac|Macintosh/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'

type Props = {
  path: string
  name: string
  parentDirName: string
  completed: boolean
  active: boolean
  selected: boolean
  /** 由父组件控制：是否正在小窗预览 */
  previewActive: boolean
  isCategoryCopy?: boolean
  mediaKind?: 'video' | 'image'
  disabled?: boolean
  onOpen: () => void
  onToggleSelect: () => void
  onRangeSelect: () => void
  /** 点击播放键：父组件决定单播或多选同播 */
  onPlayClick: () => void
}

export function VideoThumb({
  path,
  name,
  parentDirName,
  completed,
  active,
  selected,
  previewActive,
  isCategoryCopy,
  mediaKind,
  disabled,
  onOpen,
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
          .then((url: string) => {
            if (!cancelled) setSrc(url)
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

  // 父组件控制开/关小窗预览
  useEffect(() => {
    let cancelled = false
    if (!previewActive) {
      stopPreviewMedia()
      return
    }
    void (async () => {
      try {
        // Windows HEVC：安静生成兼容预览，不抢全局 busy
        const proxy = await window.api.ensurePreviewProxy(path, false, true)
        if (cancelled) return
        setPreviewUrl(proxy.url)
        setPreviewTime(0)
        setPreviewDuration(0)
        requestAnimationFrame(() => {
          if (cancelled) return
          const v = videoRef.current
          if (!v) return
          v.muted = true
          v.currentTime = 0
          void v.play().catch(() => undefined)
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
      className={`video-thumb ${active ? 'active' : ''} ${completed ? 'completed' : ''} ${selected ? 'selected' : ''} ${previewing ? 'previewing' : ''}`}
      title={`${name}\n单击：单选并打开主预览${isImage ? '' : ' · 播放键小窗预览（多选时同时播） · 进度条可拖拽'}\n${MOD_KEY}+单击多选 · Shift+单击：从锚点连选到此处\nDelete 从工作区移除（保留原文件）`}
      onMouseDown={(e) => {
        if (disabled) return
        if (e.shiftKey) e.preventDefault()
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
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration
              if (Number.isFinite(d) && d > 0) setPreviewDuration(d)
            }}
            onTimeUpdate={(e) => {
              if (scrubbingRef.current) return
              setPreviewTime(e.currentTarget.currentTime)
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const v = videoRef.current
              if (!v) return
              if (v.paused) void v.play().catch(() => undefined)
              else v.pause()
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
                ? '停止小窗预览'
                : selected
                  ? '播放：多选时同时预览所有选中视频'
                  : '小窗预览播放'
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
            title="拖拽调整进度"
            onMouseDown={startScrub}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
          >
            <div className="thumb-scrub-track">
              <div className="thumb-scrub-fill" style={{ width: `${progressPct}%` }} />
              <div className="thumb-scrub-thumb" style={{ left: `${progressPct}%` }} />
            </div>
          </div>
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
