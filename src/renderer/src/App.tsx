import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CropRect, ExportRecord, SessionState, TimeRange, VideoItem } from '../../shared/types'
import { IMAGE_TIMELINE_SECONDS, MIN_SELECTION_SECONDS, isImagePath } from '../../shared/types'
import { clamp, computeRemainingFromExports, formatTime, formatTimecode, formatTimelineTime, frameDuration, frameIndex, isMeaningfulCrop, minSelectionGap, resolveClipSelection, selectionTolerance, snapToFrame, stepByFrames, totalDuration, sanitizeName, compareMediaPaths, joinMediaDir, mediaDirname, mediaBasename } from '../../shared/utils'
import { isPresetCategory, applyCustomCategoryTags, getCustomCategoryTags, loadCustomCategoryTags, saveCustomCategoryTags, categoryShadeStyle, tryRemoveCustomCategoryTag, isBuiltinCategoryTag, findCustomCategoryGroup } from '../../shared/categories'
import { filmstripOrder, seekAndCaptureFrame, seekVideo } from './frameCapture'
import { CategoryChips } from './CategoryChips'
import { VideoThumb } from './VideoThumb'
import appIcon from './assets/app-icon.png'

/** 仅当上级目录名属于预设行为标签时，才作为默认分类名 */
function defaultCategoryFromDir(dirName: string | undefined | null): string {
  const name = (dirName || '').trim()
  return isPresetCategory(name) ? name : ''
}

/** 默认类别源目录：未归类 → 源文件所在目录；已归类 → 导出根目录 */
function defaultSaveRootDir(sourcePath: string): string {
  const parent = mediaDirname(sourcePath)
  if (isPresetCategory(mediaBasename(parent))) {
    return mediaDirname(parent)
  }
  return parent
}

/** 实际类别文件夹 = 源目录/类别名 */
function categoryDirUnderRoot(rootDir: string, category: string): string {
  const root = rootDir.trim()
  const cat = sanitizeName(category.trim())
  if (!root) return cat && cat !== 'unnamed' ? cat : ''
  if (!cat || cat === 'unnamed') return root
  return joinMediaDir(root, cat)
}

const THUMB_SIZE_MIN = 64
const THUMB_SIZE_MAX = 280
const THUMB_SIZE_DEFAULT = 128
const SIDEBAR_WIDTH_MIN = 240
const SIDEBAR_WIDTH_MAX = 720
const SIDEBAR_WIDTH_DEFAULT = 380
/** 左右分栏：拖过阈值可收起缩略区或播放区 */
const PANE_SPLITTER_W = 6
const SIDEBAR_COLLAPSE_SNAP = 72
const MAIN_COLLAPSE_SNAP = 72
const FILMSTRIP_RADIUS = 5
/** 微调步进（fps）：数值=每秒几帧；1=按1下←→走1秒，8=按8下走1秒；选帧区按此间距抽帧 */
const STEP_FPS_OPTIONS = [1, 8, 16, 22] as const
const STEP_FPS_DEFAULT = 8
const VIEW_ZOOM_MIN = 1
const VIEW_ZOOM_MAX = 5
const PLAYBACK_RATES = [0.5, 1, 2, 4] as const
/** 快捷键修饰键文案：macOS 用 ⌘，Windows/Linux 用 Ctrl（逻辑已同时认 metaKey/ctrlKey） */
const MOD_KEY = /Mac|Macintosh/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'
const IS_WIN = /Windows/i.test(navigator.userAgent)
/** Windows 上杀毒/索引常更久占用句柄；松开媒体后多等一会再 rename */
const MEDIA_RELEASE_MS = IS_WIN ? 280 : 60
const LS_THUMB = 'labelu.thumbSize'
const LS_SIDEBAR = 'labelu.sidebarWidth'
const LS_STEP_FPS = 'labelu.stepFps'
const LS_TIMELINE_ZOOM = 'labelu.timelineZoomOnSelect'
const LS_LOOP_SELECTION = 'labelu.loopSelection'
const LS_PLAYBACK_RATE = 'labelu.playbackRate'
const LS_ONLY_INCOMPLETE = 'labelu.onlyIncomplete'
/** 二次分类落点偏好 */
const LS_RECLASSIFY_DONT_ASK = 'labelu.reclassifyDontAsk'
const LS_RECLASSIFY_MODE = 'labelu.reclassifyMode'
const LS_RECLASSIFY_CUSTOM_DIR = 'labelu.reclassifyCustomDir'
/** 选帧区高度：可拖大（占用播放区空间）；剪辑区按内容撑开且不可折叠 */
const LS_FILMSTRIP_HEIGHT = 'labelu.filmstripHeight'
const FILMSTRIP_HEIGHT_DEFAULT = 148
const FILMSTRIP_HEIGHT_MIN = 96
/** 播放区最小高度；选帧区最大高度 = 剩余空间，不另设硬顶 */
const VIDEO_STAGE_MIN = 100
const PLAYER_SPLITTER_H = 16

type FilmstripItem = { time: number; url: string | null; center: boolean }
type FilmstripState = {
  which: 'in' | 'out'
  centerTime: number
  items: FilmstripItem[]
}

function loadStoredBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === '1' || v === 'true') return true
    if (v === '0' || v === 'false') return false
  } catch {
    /* ignore */
  }
  return fallback
}

function loadStoredNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const n = Number(localStorage.getItem(key))
    if (Number.isFinite(n)) return clamp(n, min, max)
  } catch {
    /* ignore */
  }
  return fallback
}

function loadStepFps(): number {
  const raw = loadStoredNumber(LS_STEP_FPS, STEP_FPS_DEFAULT, 1, 120)
  if ((STEP_FPS_OPTIONS as readonly number[]).includes(raw)) return raw
  return STEP_FPS_OPTIONS.reduce((best, opt) =>
    Math.abs(opt - raw) < Math.abs(best - raw) ? opt : best
  )
}

function loadStoredPlaybackRate(): number {
  const raw = loadStoredNumber(LS_PLAYBACK_RATE, 1, 0.25, 8)
  if ((PLAYBACK_RATES as readonly number[]).includes(raw)) return raw
  return 1
}

type EdgeMoveResult =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: string }

function exportBlockingSelection(
  start: number,
  end: number,
  clipExports: ExportRecord[]
): ExportRecord | null {
  const a = Math.min(start, end)
  const b = Math.max(start, end)
  return (
    clipExports.find((e) => !e.approx && a < e.end - 0.02 && b > e.start + 0.02) ?? null
  )
}

function explainPointerOutsideRemaining(
  pointerTime: number,
  remaining: TimeRange[],
  clipExports: ExportRecord[]
): string {
  const hitExp = clipExports.find(
    (e) => !e.approx && pointerTime >= e.start - 0.02 && pointerTime <= e.end + 0.02
  )
  if (hitExp) {
    return `指针落在已分类片段「${hitExp.category}」（${formatTime(hitExp.start)}–${formatTime(hitExp.end)}），请拖到未分类灰色区域`
  }
  if (remaining.length === 0) return '没有可剪的未分类时段'
  return '指针不在可剪的未分类时段内'
}

/**
 * 拖动/微调入出点：拖出点时锁定入点，拖入点时锁定出点；仅拖入点可跨剩余段跳转。
 */
function tryMoveSelectionEdge(
  which: 'in' | 'out',
  pointerTime: number,
  liveStart: number,
  liveEnd: number,
  remaining: TimeRange[],
  stepFps: number,
  clipExports: ExportRecord[]
): EdgeMoveResult {
  const tol = selectionTolerance(stepFps)
  let ns = Math.min(liveStart, liveEnd)
  let ne = Math.max(liveStart, liveEnd)

  const ptrHost =
    remaining.find((r) => pointerTime >= r.start - tol && pointerTime <= r.end + tol) ?? null
  if (!ptrHost || !(ptrHost.end > ptrHost.start)) {
    return {
      ok: false,
      reason: explainPointerOutsideRemaining(pointerTime, remaining, clipExports)
    }
  }

  if (which === 'in') {
    const neHost =
      remaining.find((r) => ne >= r.start - tol && ne <= r.end + tol) ?? null
    if (neHost && neHost !== ptrHost) {
      const lo = ptrHost.start
      const hi = ptrHost.end
      const minGap = minSelectionGap(hi - lo)
      const prefer = Math.min(Math.max(minGap, ne - ns, MIN_SELECTION_SECONDS), hi - lo)
      ns = clamp(pointerTime, lo, Math.max(lo, hi - minGap))
      ne = clamp(ns + prefer, ns + minGap, hi)
    } else {
      const host = ptrHost
      const lo = host.start
      const hi = host.end
      const minGap = minSelectionGap(hi - lo)
      ns = clamp(pointerTime, lo, Math.max(lo, ne - minGap))
      if (ne - ns < minGap - 1e-6) ns = Math.max(lo, ne - minGap)
    }
  } else {
    const nsHost =
      remaining.find((r) => ns >= r.start - tol && ns <= r.end + tol) ?? null
    if (!nsHost) {
      return { ok: false, reason: '入点不在可剪区域内，请先调整入点' }
    }
    if (nsHost !== ptrHost) {
      return {
        ok: false,
        reason: explainPointerOutsideRemaining(pointerTime, remaining, clipExports)
      }
    }
    const lo = nsHost.start
    const hi = nsHost.end
    const minGap = minSelectionGap(hi - lo)
    ne = clamp(pointerTime, Math.min(hi, ns + minGap), hi)
    if (ne - ns < minGap - 1e-6) ne = Math.min(hi, ns + minGap)
  }

  if (ne - ns < MIN_SELECTION_SECONDS - 1e-6) {
    return {
      ok: false,
      reason: `选区不能短于 ${MIN_SELECTION_SECONDS} 秒（当前可剪时段过短或入/出点过近）`
    }
  }

  const hit = exportBlockingSelection(ns, ne, clipExports)
  if (hit) {
    return {
      ok: false,
      reason: `选区与已分类片段「${hit.category}」（${formatTime(hit.start)}–${formatTime(hit.end)}）重叠`
    }
  }

  return { start: ns, end: ne, ok: true }
}

function validateSelectionRange(
  start: number,
  end: number,
  remaining: TimeRange[],
  clipExports: ExportRecord[],
  stepFps: number
): EdgeMoveResult {
  const result = resolveClipSelection(start, end, remaining, clipExports, stepFps)
  if (!result.ok) return { ok: false, reason: result.reason }
  return { ok: true, start: result.start, end: result.end }
}

/** 默认选区：从可剪段起点到段尾（新视频即入点在片头、出点在片尾） */
function selectionSpanFromRemaining(
  ranges: TimeRange[],
  fallbackEnd = 0
): { start: number; end: number } {
  const first = ranges[0]
  if (first && first.end > first.start) {
    return { start: first.start, end: first.end }
  }
  const end = Math.max(0, fallbackEnd)
  if (end <= 0) {
    return { start: 0, end: MIN_SELECTION_SECONDS }
  }
  return { start: 0, end }
}

const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 }

function reportClientError(tag: string, err: unknown, extra?: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    void window.api?.logClientError?.({ tag, message, stack, extra })
  } catch {
    /* ignore */
  }
}

function normMediaPath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  // Windows 路径大小写不敏感：统一小写，避免对话框/拖放大小写不一致导致匹配失败
  if (/Windows/i.test(navigator.userAgent)) s = s.toLowerCase()
  return s
}

function fileNameOf(filePath: string): string {
  const n = normMediaPath(filePath)
  const i = n.lastIndexOf('/')
  return i >= 0 ? n.slice(i + 1) : n
}

/** object-fit: contain 下，视频实际画面在容器内的像素矩形 */
function containContentRect(
  containerW: number,
  containerH: number,
  mediaW: number,
  mediaH: number
): { left: number; top: number; width: number; height: number } {
  if (!(containerW > 0) || !(containerH > 0)) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  if (!(mediaW > 0) || !(mediaH > 0)) {
    return { left: 0, top: 0, width: containerW, height: containerH }
  }
  const scale = Math.min(containerW / mediaW, containerH / mediaH)
  const width = mediaW * scale
  const height = mediaH * scale
  return {
    left: (containerW - width) / 2,
    top: (containerH - height) / 2,
    width,
    height
  }
}

type SaveModal = {
  start: number
  end: number
  crop: CropRect
  cropActive: boolean
  previewUrl: string
}

type ConfirmModal = {
  title: string
  message: string
  confirmText?: string
  onConfirm: () => void
  onCancel?: () => void
}

type BatchResultItem = {
  path: string
  ok: boolean
  exportPath?: string
  error?: string
}

type BatchResultModal = {
  category: string
  results: BatchResultItem[]
  canUndo: boolean
  cancelled?: boolean
}

type ReclassifyDestMode = 'originalRoot' | 'underCurrent' | 'custom' | 'customRoot'

type ReclassifyDestModal = {
  purpose: 'batch'
  category: string
  paths: string[]
  categorizedCount: number
}

type ClassifyDestOpts = {
  reclassifyMode?: ReclassifyDestMode
  customDestDir?: string
}

type PendingSaveClip = {
  category: string
  saveModal: SaveModal
  isImage: boolean
  sourcePath: string
  duration: number
}

function loadReclassifyMode(): ReclassifyDestMode {
  const v = localStorage.getItem(LS_RECLASSIFY_MODE)
  if (v === 'underCurrent' || v === 'custom' || v === 'originalRoot') return v
  return 'originalRoot'
}

function reclassifyModeLabel(mode: ReclassifyDestMode): string {
  if (mode === 'underCurrent') return '当前目录下新建类别'
  if (mode === 'custom') return '自选目标文件夹'
  return '原目录对应类别'
}

type TimelineMarker = {
  id: string
  time: number
}

type UiUndoEntry =
  | {
      kind: 'selection'
      selStart: number
      selEnd: number
      fineTuneWhich: 'in' | 'out' | null
    }
  | {
      kind: 'markers'
      markers: TimelineMarker[]
      label: string
    }

type RecoverModal = {
  sessions: SessionState[]
  index: number
}

type DeleteCategoryTagModal = {
  tag: string
}

type WhatsNewModal = {
  title: string
  lines: string[]
  version: string
}

/** 打开文件对话框的默认路径：优先当前文件（跨平台比仅目录更可靠） */
function dialogDefaultPathFor(current: VideoItem | null, videos: VideoItem[]): string | undefined {
  const from = current?.path || videos[0]?.path
  if (!from) return undefined
  const p = String(from).trim()
  return p || undefined
}

function itemIsImage(v: VideoItem): boolean {
  return v.mediaKind === 'image' || isImagePath(v.path)
}

/** 是否应在「只看未完成」列表中显示 */
function videoShowsAsIncomplete(
  v: VideoItem,
  listIndex: number,
  currentIndex: number,
  remainingByPath: Map<string, number> | Record<string, number>
): boolean {
  if (v.completed) return false
  const rem =
    remainingByPath instanceof Map ? remainingByPath.get(v.path) : remainingByPath[v.path]
  if (rem !== undefined && rem >= 0 && rem <= 0.05) return listIndex === currentIndex
  return true
}

type MediaKindFilter = 'all' | 'video' | 'image'

type ImportChoiceModal = {
  items: VideoItem[]
  videoCount: number
  imageCount: number
}

export default function App(): React.JSX.Element {
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [index, setIndex] = useState(0)
  const [onlyIncomplete, setOnlyIncomplete] = useState(() => loadStoredBool(LS_ONLY_INCOMPLETE, true))
  const [mediaUrl, setMediaUrl] = useState('')
  /** 点击已分类段时播放导出的 H.264 片段（片源常为 HEVC，Chromium 易花屏） */
  const [exportPreviewUrl, setExportPreviewUrl] = useState<string | null>(null)
  const exportPreviewUrlRef = useRef<string | null>(null)
  exportPreviewUrlRef.current = exportPreviewUrl
  const mediaUrlRef = useRef('')
  mediaUrlRef.current = mediaUrl
  const [duration, setDuration] = useState(0)
  const [fps, setFps] = useState(25)
  const [currentTime, setCurrentTime] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(() => loadStoredPlaybackRate())
  const completedRef = useRef(false)
  const [stepFps, setStepFps] = useState(() => loadStepFps())
  /**
   * 选段后是否在时间轴上放大选区：
   * true=「选区」模式；false=「全片」模式（选段后仍显示整段时间轴）
   */
  const [timelineZoomOnSelect, setTimelineZoomOnSelect] = useState(() =>
    loadStoredBool(LS_TIMELINE_ZOOM, true)
  )
  /** 选区放大模式下的时间轴视窗 */
  const [timelineFocus, setTimelineFocus] = useState<{ start: number; end: number } | null>(null)
  const [filmstripHeight, setFilmstripHeight] = useState(() =>
    loadStoredNumber(LS_FILMSTRIP_HEIGHT, FILMSTRIP_HEIGHT_DEFAULT, FILMSTRIP_HEIGHT_MIN, 4000)
  )
  const [selStart, setSelStart] = useState(0)
  const [selEnd, setSelEnd] = useState(MIN_SELECTION_SECONDS)
  const [remaining, setRemaining] = useState<TimeRange[]>([])
  const [clipExports, setClipExports] = useState<ExportRecord[]>([])
  const [selectedExportPath, setSelectedExportPath] = useState<string | null>(null)
  const [undoCount, setUndoCount] = useState(0)
  /** 选区循环预览（空格播放，到出点后回到入点） */
  const [loopSelection, setLoopSelection] = useState(() => loadStoredBool(LS_LOOP_SELECTION, false))
  const [edgeDragTime, setEdgeDragTime] = useState<number | null>(null)
  const [timelineMarkers, setTimelineMarkers] = useState<TimelineMarker[]>([])
  const [crop, setCrop] = useState<CropRect>(FULL_CROP)
  const [cropActive, setCropActive] = useState(false)
  /** 用户已拖出裁切框（进入裁切后不预设框） */
  const [cropCommitted, setCropCommitted] = useState(false)
  const [mediaKindFilter, setMediaKindFilter] = useState<MediaKindFilter>('all')
  const [importChoiceModal, setImportChoiceModal] = useState<ImportChoiceModal | null>(null)
  const [viewZoom, setViewZoom] = useState(1)
  const [viewPan, setViewPan] = useState({ x: 0, y: 0 })
  const [videoNatural, setVideoNatural] = useState({ w: 0, h: 0 })
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 })
  const [busy, setBusy] = useState(false)
  const [busyProgress, setBusyProgress] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [saveModal, setSaveModal] = useState<SaveModal | null>(null)
  /** 保存预览：相对选区起点的播放进度（秒） */
  const [savePreviewLocal, setSavePreviewLocal] = useState(0)
  const [savePreviewPlaying, setSavePreviewPlaying] = useState(false)
  const [categoryInput, setCategoryInput] = useState('')
  /** 类别文件夹的源目录（实际写入 源目录/类别名/） */
  const [saveDestRoot, setSaveDestRoot] = useState('')
  /** 本次运行内用户自定义的源目录；重启失效 */
  const sessionCustomSaveRootRef = useRef<string | null>(null)
  const [confirmModal, setConfirmModal] = useState<ConfirmModal | null>(null)
  const [recoverModal, setRecoverModal] = useState<RecoverModal | null>(null)
  const [deleteCategoryTagModal, setDeleteCategoryTagModal] = useState<DeleteCategoryTagModal | null>(
    null
  )
  /** 本次运行内跳过删除自定义标签确认；重启后清空 */
  const deleteCategoryTagSkipAskRef = useRef(false)
  const [deleteCategoryTagDontAsk, setDeleteCategoryTagDontAsk] = useState(false)
  /** 自定义标签增删后刷新 CategoryChips */
  const [categoryTagsRevision, setCategoryTagsRevision] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [status, setStatus] = useState('')
  const [updateBanner, setUpdateBanner] = useState<string | null>(null)
  const [whatsNewModal, setWhatsNewModal] = useState<WhatsNewModal | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [thumbSize, setThumbSize] = useState(() =>
    loadStoredNumber(LS_THUMB, THUMB_SIZE_DEFAULT, THUMB_SIZE_MIN, THUMB_SIZE_MAX)
  )
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    loadStoredNumber(LS_SIDEBAR, SIDEBAR_WIDTH_DEFAULT, 0, 4000)
  )
  const [paneBodyW, setPaneBodyW] = useState(0)
  const appBodyRef = useRef<HTMLDivElement>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  /** 缩略图小窗预览中的视频 id（多选同播时含多个） */
  const [thumbPreviewIds, setThumbPreviewIds] = useState<Set<string>>(() => new Set())
  const [batchModal, setBatchModal] = useState(false)
  const [batchCategory, setBatchCategory] = useState('')
  /** 最近一次批量移动的列表项，供 UI 一次撤回 */
  const [batchUndoItems, setBatchUndoItems] = useState<VideoItem[] | null>(null)
  const [batchResultModal, setBatchResultModal] = useState<BatchResultModal | null>(null)
  const [reclassifyDestModal, setReclassifyDestModal] = useState<ReclassifyDestModal | null>(null)
  const [reclassifyMode, setReclassifyMode] = useState<ReclassifyDestMode>(() => loadReclassifyMode())
  const [reclassifyCustomDir, setReclassifyCustomDir] = useState(
    () => localStorage.getItem(LS_RECLASSIFY_CUSTOM_DIR) || ''
  )
  const [reclassifyDontAsk, setReclassifyDontAsk] = useState(false)
  const [reclassifyPrefDontAsk, setReclassifyPrefDontAsk] = useState(() =>
    loadStoredBool(LS_RECLASSIFY_DONT_ASK, false)
  )
  const lastClassifyOptsRef = useRef<ClassifyDestOpts | undefined>(undefined)
  /** 更新说明弹窗关闭后再展示「恢复未完成会话」 */
  const pendingRecoverSessionsRef = useRef<SessionState[] | null>(null)
  /** 合并并发的 clearCompleted，避免拖动手柄连点竞态 */
  const clearCompletedInflightRef = useRef<Promise<string | null> | null>(null)
  const finishCurrentRef = useRef<(opts?: { silent?: boolean }) => Promise<boolean>>(
    async () => true
  )
  const goRelativeRef = useRef<(dir: -1 | 1) => Promise<void>>(async () => {})
  const [uiUndoStack, setUiUndoStack] = useState<UiUndoEntry[]>([])
  const selectAnchorRef = useRef<number | null>(null)
  /** 路径 → 剩余可剪秒数；用于「只看未完成」筛掉已全部打标但未点完成的项 */
  const remainingByPathRef = useRef<Map<string, number>>(new Map())
  const [remainingHints, setRemainingHints] = useState<Record<string, number>>({})
  const thumbGridRef = useRef<HTMLDivElement>(null)
  /** 弹窗打开时屏蔽全局快捷键（避免 effect 依赖弹窗状态导致每帧重绑） */
  const modalOpenRef = useRef(false)
  modalOpenRef.current = Boolean(
    saveModal ||
      confirmModal ||
      batchModal ||
      batchResultModal ||
      reclassifyDestModal ||
      recoverModal ||
      deleteCategoryTagModal ||
      importChoiceModal ||
      whatsNewModal
  )
  const saveModalOpenRef = useRef(false)
  saveModalOpenRef.current = Boolean(saveModal)

  const videoRef = useRef<HTMLVideoElement>(null)
  /** 当前主预览对应的源路径；HEVC 代理失败重试用 */
  const playSourcePathRef = useRef('')
  const previewProxyTriedRef = useRef(false)
  const imageRef = useRef<HTMLImageElement>(null)
  const cropRef = useRef<CropRect>(FULL_CROP)
  cropRef.current = crop
  const scrubVideoRef = useRef<HTMLVideoElement>(null)
  const savePreviewRef = useRef<HTMLVideoElement>(null)
  /** 保存预览循环时防 timeupdate 重入 */
  const savePreviewLoopGuardRef = useRef(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const playerWrapRef = useRef<HTMLDivElement>(null)
  const timelineFooterRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const dirtyRef = useRef(false)
  const navigatingRef = useRef(false)
  const savingRef = useRef(false)
  /** 确认保存后短暂忽略 Enter，避免同一次回车/按住重复把保存窗又打开 */
  const ignoreEnterOpenUntilRef = useRef(0)
  const confirmSaveRef = useRef<() => Promise<void>>(async () => {})
  const loadGenRef = useRef(0)
  /** 选区预览：播放到该时间后自动暂停 */
  const previewEndRef = useRef<number | null>(null)
  const selectionLoopGuardRef = useRef(false)
  const loopSelectionRef = useRef(loopSelection)
  loopSelectionRef.current = loopSelection
  const timelineMarkersRef = useRef<TimelineMarker[]>([])
  timelineMarkersRef.current = timelineMarkers
  /** 递增以作废尚未完成的 play()，避免定格后又被异步播放拉起 */
  const playbackGenRef = useRef(0)
  const selStartRef = useRef(selStart)
  const selEndRef = useRef(selEnd)
  const frameCacheRef = useRef(new Map<string, string>())
  const filmstripGenRef = useRef(0)
  /** 作废 playSelection.finally 里过期的选帧刷新（避免方向键微调后又被旧边沿盖回） */
  const filmstripAfterPlayTokenRef = useRef(0)
  const filmstripRafRef = useRef(0)
  /** 缩放平移后抑制一次 click，避免误触播放/暂停 */
  const stageClickSuppressRef = useRef(false)
  const videoStageClickTimerRef = useRef(0)
  const viewZoomRef = useRef(1)
  const viewPanRef = useRef({ x: 0, y: 0 })
  viewZoomRef.current = viewZoom
  viewPanRef.current = viewPan
  selStartRef.current = selStart
  selEndRef.current = selEnd

  const resetViewZoom = useCallback(() => {
    setViewZoom(1)
    setViewPan({ x: 0, y: 0 })
  }, [])

  const clampViewPan = useCallback((zoom: number, pan: { x: number; y: number }) => {
    const stage = stageRef.current
    if (!stage || zoom <= 1.001) return { x: 0, y: 0 }
    const w = stage.clientWidth
    const h = stage.clientHeight
    const maxX = ((zoom - 1) * w) / 2
    const maxY = ((zoom - 1) * h) / 2
    return {
      x: clamp(pan.x, -maxX, maxX),
      y: clamp(pan.y, -maxY, maxY)
    }
  }, [])

  const [filmstrip, setFilmstrip] = useState<FilmstripState | null>(null)
  /** 选帧点击后盖在播放区上的定格图（规避部分编码暂停态 seek 不刷新画面） */
  const [stillFrameUrl, setStillFrameUrl] = useState<string | null>(null)
  const [fineTuneWhich, setFineTuneWhich] = useState<'in' | 'out' | null>(null)
  const fineTuneWhichRef = useRef<'in' | 'out' | null>(null)
  fineTuneWhichRef.current = fineTuneWhich
  const stepFpsRef = useRef(stepFps)
  stepFpsRef.current = stepFps
  const stepFpsBootRef = useRef(true)

  useEffect(() => {
    loadCustomCategoryTags()
    try {
      // 旧版按类别持久化源目录；现改为仅本次运行有效
      localStorage.removeItem('labelu.categorySaveDirs')
    } catch {
      /* ignore */
    }
    void window.api.getCustomCategories().then((map) => {
      const hasMain = Object.values(map || {}).some((a) => Array.isArray(a) && a.length > 0)
      if (hasMain) {
        applyCustomCategoryTags(map)
        saveCustomCategoryTags()
      } else {
        const local = getCustomCategoryTags()
        if (Object.values(local).some((a) => a.length > 0)) {
          void window.api.setCustomCategories(local)
        }
      }
    })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(LS_LOOP_SELECTION, loopSelection ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [loopSelection])

  useEffect(() => {
    try {
      localStorage.setItem(LS_PLAYBACK_RATE, String(playbackRate))
    } catch {
      /* ignore */
    }
  }, [playbackRate])

  useEffect(() => {
    try {
      localStorage.setItem(LS_ONLY_INCOMPLETE, onlyIncomplete ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [onlyIncomplete])

  useEffect(() => {
    try {
      localStorage.setItem(LS_STEP_FPS, String(stepFps))
    } catch {
      /* ignore */
    }
  }, [stepFps])

  useEffect(() => {
    try {
      localStorage.setItem(LS_TIMELINE_ZOOM, timelineZoomOnSelect ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [timelineZoomOnSelect])

  const pushUiUndo = useCallback((entry: UiUndoEntry) => {
    setUiUndoStack((prev) => [...prev.slice(-19), entry])
  }, [])

  const exitAllEditing = useCallback(() => {
    filmstripGenRef.current++
    setFineTuneWhich(null)
    setFilmstrip(null)
    setTimelineFocus(null)
    setSelectedExportPath(null)
    setExportPreviewUrl(null)
    setCropActive(false)
    setCropCommitted(false)
    setCrop(FULL_CROP)
    setStatus('已退出编辑（全片/选区偏好未改）')
  }, [])

  const timelineView = useMemo(() => {
    const full = { start: 0, end: Math.max(0, duration), span: Math.max(0.05, duration || 0.05) }
    // 全片模式：始终整段；选区模式且已有聚焦视窗：放大到选段
    if (!timelineZoomOnSelect || !timelineFocus || !(duration > 0)) return full
    const span = Math.max(timelineFocus.end - timelineFocus.start, 0.05)
    return { start: timelineFocus.start, end: timelineFocus.end, span }
  }, [timelineZoomOnSelect, timelineFocus, duration])
  const timelineViewRef = useRef(timelineView)
  timelineViewRef.current = timelineView

  const enterTimelineFocus = useCallback(
    (start: number, end: number) => {
      const a = Math.min(start, end)
      const b = Math.max(start, end)
      const pad = Math.max(2 / Math.max(1, stepFpsRef.current), (b - a) * 0.15, 0.35)
      setTimelineFocus({
        start: clamp(a - pad, 0, duration),
        end: clamp(b + pad, 0, duration)
      })
    },
    [duration]
  )

  const clearTimelineFocus = useCallback(() => {
    setTimelineFocus(null)
  }, [])

  const timelineFocusRef = useRef(timelineFocus)
  timelineFocusRef.current = timelineFocus
  const timelineZoomOnSelectRef = useRef(timelineZoomOnSelect)
  timelineZoomOnSelectRef.current = timelineZoomOnSelect

  /** 选区模式下：选段超出当前视窗时重载聚焦 */
  const ensureTimelineFocusCovers = useCallback(
    (start: number, end: number) => {
      if (!timelineZoomOnSelectRef.current) return
      const a = Math.min(start, end)
      const b = Math.max(start, end)
      if (!(b - a >= 0.05)) return
      const focus = timelineFocusRef.current
      if (!focus || a < focus.start - 1e-3 || b > focus.end + 1e-3) {
        enterTimelineFocus(a, b)
      }
    },
    [enterTimelineFocus]
  )

  /** 选段完成：仅在「选区」模式下把时间轴放大到选段 */
  const refocusTimelineToSelection = useCallback(
    (start: number, end: number) => {
      const a = Math.min(start, end)
      const b = Math.max(start, end)
      if (!(b - a >= 0.05)) return
      if (!timelineZoomOnSelectRef.current) {
        clearTimelineFocus()
        return
      }
      enterTimelineFocus(a, b)
    },
    [enterTimelineFocus, clearTimelineFocus]
  )

  const setTimelineModeFull = useCallback(() => {
    setTimelineZoomOnSelect(false)
    clearTimelineFocus()
  }, [clearTimelineFocus])

  const setTimelineModeSelection = useCallback(() => {
    setTimelineZoomOnSelect(true)
    const a = Math.min(selStartRef.current, selEndRef.current)
    const b = Math.max(selStartRef.current, selEndRef.current)
    if (b - a >= 0.05) enterTimelineFocus(a, b)
  }, [enterTimelineFocus])

  const timeToPct = useCallback(
    (t: number): number => ((t - timelineView.start) / timelineView.span) * 100,
    [timelineView]
  )
  /** 手柄显示位置限制在轨道内，避免贴边被 overflow 裁掉像「飞出」 */
  const handleToPct = useCallback(
    (t: number): number => clamp(timeToPct(t), 0.6, 99.4),
    [timeToPct]
  )
  const rangeToPct = useCallback(
    (t0: number, t1: number): { left: number; width: number } => {
      const a = Math.min(t0, t1)
      const b = Math.max(t0, t1)
      const left = clamp(timeToPct(a), 0, 100)
      const right = clamp(timeToPct(b), 0, 100)
      return {
        left,
        width: Math.max(0, right - left)
      }
    },
    [timeToPct]
  )

  const errText = (err: unknown): string => {
    if (err instanceof Error) return err.message
    if (typeof err === 'string') return err
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }

  const toastTimerRef = useRef(0)
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = 0
      setToast(null)
    }, 3500)
  }, [])

  const syncRemainingHint = useCallback((path: string, seconds: number) => {
    remainingByPathRef.current.set(path, seconds)
    setRemainingHints((prev) => (prev[path] === seconds ? prev : { ...prev, [path]: seconds }))
  }, [])

  const refreshRemainingHints = useCallback(async (list: VideoItem[]) => {
    if (!list.length) return
    try {
      const hints = await window.api.batchRemainingHints(list.map((v) => v.path))
      for (const [path, sec] of Object.entries(hints)) {
        remainingByPathRef.current.set(path, Number(sec))
      }
      setRemainingHints((prev) => ({ ...prev, ...hints }))
    } catch {
      /* ignore */
    }
  }, [])

  /** 播放选区 [start, end]：必须从选区起点播到出点，绝不是片头 */
  const playSelection = useCallback(
    async (start?: number, end?: number) => {
      // 退出导出片段预览，回到源片选区播放
      setExportPreviewUrl(null)

      const rawA = start ?? selStartRef.current
      const rawB = end ?? selEndRef.current
      if (!Number.isFinite(rawA) || !Number.isFinite(rawB)) return
      const a = Math.min(rawA, rawB)
      const b = Math.max(rawA, rawB)
      if (b - a < 0.05) {
        setStatus('选区过短，无法播放')
        return
      }

      // 独占播放：作废其它 seek/play，并暂时卸掉 scrub，避免双 video 抢 seek
      const gen = ++playbackGenRef.current
      filmstripGenRef.current++
      previewEndRef.current = null
      setStillFrameUrl(null)

      // 等一帧让 src 切回源片
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      if (gen !== playbackGenRef.current) return
      const v = videoRef.current
      if (!v) return
      if (mediaUrl && v.getAttribute('src') !== mediaUrl) {
        try {
          v.src = mediaUrl
          await new Promise<void>((resolve) => {
            const done = (): void => {
              v.removeEventListener('loadeddata', done)
              resolve()
            }
            v.addEventListener('loadeddata', done)
            window.setTimeout(done, 800)
          })
        } catch {
          /* ignore */
        }
        if (gen !== playbackGenRef.current) return
      }

      const scrub = scrubVideoRef.current
      let scrubRestored = false
      const restoreScrub = (): void => {
        if (scrubRestored || !scrub || !mediaUrl) return
        scrubRestored = true
        try {
          if (scrub.src !== mediaUrl) scrub.src = mediaUrl
        } catch {
          /* ignore */
        }
      }

      if (scrub) {
        try {
          scrub.pause()
          scrub.removeAttribute('src')
          scrub.load()
        } catch {
          /* ignore */
        }
      }

      try {
        v.pause()
      } catch {
        /* ignore */
      }
      v.playbackRate = playbackRate

      const seekOnce = async (t: number): Promise<void> => {
        try {
          await seekVideo(v, t, 900)
        } catch {
          try {
            v.currentTime = t
          } catch {
            /* ignore */
          }
          await new Promise((r) => window.setTimeout(r, 120))
        }
      }

      // 两步 seek，提高落到选区起点的成功率
      const nudge = a < 0.12 ? Math.min(a + 0.2, Math.max(0, b - 0.05)) : Math.max(0, a - 0.12)
      await seekOnce(nudge)
      if (gen !== playbackGenRef.current) {
        restoreScrub()
        return
      }
      await seekOnce(a)
      if (gen !== playbackGenRef.current) {
        restoreScrub()
        return
      }

      if (Math.abs(v.currentTime - a) > 0.4) {
        await seekOnce(a)
        if (gen !== playbackGenRef.current) {
          restoreScrub()
          return
        }
      }

      // 仍不在起点：明确提示（便于排查），但仍尝试播放
      const landed = v.currentTime
      previewEndRef.current = b
      setCurrentTime(landed)
      setStatus(
        Math.abs(landed - a) > 0.5
          ? `选区播放异常：目标 ${formatTime(a)}，实际 ${formatTime(landed)}`
          : loopSelectionRef.current
            ? `循环播放选区 ${formatTime(a)} → ${formatTime(b)}`
            : `播放选区 ${formatTime(a)} → ${formatTime(b)}（${(b - a).toFixed(1)}秒）`
      )

      try {
        await v.play()
      } catch {
        /* ignore */
      }
      if (gen !== playbackGenRef.current) {
        try {
          v.pause()
        } catch {
          /* ignore */
        }
      }

      // 延迟恢复 scrub，避免立刻抢 seek
      window.setTimeout(restoreScrub, 400)
    },
    [playbackRate, mediaUrl]
  )

  /** 播放选区可能临时卸掉 scrub；抓选帧前先恢复 */
  const ensureScrubReady = useCallback((): HTMLVideoElement | null => {
    const scrub = scrubVideoRef.current
    if (!scrub) return null
    if (!mediaUrl) return scrub
    try {
      if (!scrub.getAttribute('src')) {
        scrub.src = mediaUrl
      }
    } catch {
      /* ignore */
    }
    return scrub
  }, [mediaUrl])

  const seekPreviewFrame = useCallback((time: number, opts?: { force?: boolean }): Promise<void> => {
    const v = videoRef.current
    if (!v) return Promise.resolve()
    const force = opts?.force === true
    const gen = ++playbackGenRef.current
    // 注意：不要在这里 ++filmstripGenRef，否则会把紧随其后的选帧刷新直接作废
    previewEndRef.current = null
    try {
      v.pause()
    } catch {
      /* ignore */
    }

    const target = Math.max(0, time)

    return new Promise<void>((resolve) => {
      const finish = (): void => {
        if (gen === playbackGenRef.current) {
          try {
            v.pause()
          } catch {
            /* ignore */
          }
          setCurrentTime(v.currentTime)
          // 底层已落到目标帧后再去掉定格遮罩
          setStillFrameUrl(null)
        }
        resolve()
      }

      const seekTo = (t: number, then: () => void): void => {
        // 已被 playSelection 等作废则绝不再写 currentTime，避免打断选区播放
        if (gen !== playbackGenRef.current) {
          then()
          return
        }
        const onSeeked = (): void => {
          v.removeEventListener('seeked', onSeeked)
          window.clearTimeout(failSafe)
          then()
        }
        const failSafe = window.setTimeout(() => {
          v.removeEventListener('seeked', onSeeked)
          then()
        }, 450)
        v.addEventListener('seeked', onSeeked)
        try {
          if (gen !== playbackGenRef.current) {
            window.clearTimeout(failSafe)
            v.removeEventListener('seeked', onSeeked)
            then()
            return
          }
          v.currentTime = t
        } catch {
          window.clearTimeout(failSafe)
          v.removeEventListener('seeked', onSeeked)
          then()
        }
      }

      if (force && Math.abs(v.currentTime - target) < 0.001) {
        const nudge = target < 0.05 ? target + 0.04 : Math.max(0, target - 0.04)
        seekTo(nudge, () => {
          if (gen !== playbackGenRef.current) {
            resolve()
            return
          }
          seekTo(target, finish)
        })
        return
      }

      if (!force && Math.abs(v.currentTime - target) < 0.0005 && v.readyState >= 2) {
        finish()
        return
      }

      seekTo(target, finish)
      if (gen === playbackGenRef.current) setCurrentTime(target)
    })
  }, [])

  useEffect(() => {
    const v = videoRef.current
    if (v) v.playbackRate = playbackRate
  }, [playbackRate, mediaUrl])

  useEffect(() => {
    // 丢弃旧版低清缩略图缓存
    frameCacheRef.current.clear()
  }, [])

  useEffect(() => {
    frameCacheRef.current.clear()
    filmstripGenRef.current++
    setFilmstrip(null)
    setFineTuneWhich(null)
    setStillFrameUrl(null)
    resetViewZoom()
  }, [mediaUrl, resetViewZoom])

  /** 播放区滚轮缩放（以光标为中心）；放大后可拖拽平移 */
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      let dy = e.deltaY
      if (e.deltaMode === 1) dy *= 16
      if (e.deltaMode === 2) dy *= el.clientHeight
      const sensitivity = Math.abs(dy) < 40 ? 0.0028 : 0.0018
      const factor = clamp(Math.exp(-dy * sensitivity), 0.86, 1.16)
      const prev = viewZoomRef.current
      const next = clamp(prev * factor, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX)
      if (Math.abs(next - prev) < 0.001) return
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left - rect.width / 2
      const my = e.clientY - rect.top - rect.height / 2
      const pan = viewPanRef.current
      const nextPan =
        next <= 1.001
          ? { x: 0, y: 0 }
          : clampViewPan(next, {
              x: mx - ((mx - pan.x) * next) / prev,
              y: my - ((my - pan.y) * next) / prev
            })
      setViewZoom(next)
      setViewPan(nextPan)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [clampViewPan, mediaUrl])

  const buildFilmstripItems = useCallback(
    (centerTime: number): FilmstripItem[] => {
      const fpsStep = stepFps
      const dur = Math.max(0, duration)
      // 中心格=入/出点精确时间；左右格严格按步进网格抽帧（步进8 → 间距 1/8 秒）
      const edge = clamp(centerTime, 0, dur)
      const centerIdx = frameIndex(edge, fpsStep)
      const items: FilmstripItem[] = []
      for (let i = -FILMSTRIP_RADIUS; i <= FILMSTRIP_RADIUS; i++) {
        const t = i === 0 ? edge : clamp((centerIdx + i) / fpsStep, 0, dur)
        const cacheKey = `${fpsStep}:${Math.round(t * 1000)}`
        items.push({
          time: t,
          url: frameCacheRef.current.get(cacheKey) ?? null,
          center: i === 0
        })
      }
      return items
    },
    [duration, stepFps]
  )

  const refreshFilmstrip = useCallback(
    (which: 'in' | 'out', centerTime: number) => {
      const gen = ++filmstripGenRef.current
      const fpsStep = stepFpsRef.current
      const dur = Math.max(0, duration)
      const edge = clamp(centerTime, 0, dur)
      const centerIdx = frameIndex(edge, fpsStep)
      const items = buildFilmstripItems(edge)
      setFilmstrip({ which, centerTime: edge, items })

      const video = ensureScrubReady()
      if (!video || !mediaUrl || duration <= 0) return

      const offsets = filmstripOrder(FILMSTRIP_RADIUS)

      void (async () => {
        for (const off of offsets) {
          if (gen !== filmstripGenRef.current) return
          const t = off === 0 ? edge : clamp((centerIdx + off) / fpsStep, 0, dur)
          // 用步进帧索引做缓存键，避免换步进后误用旧间距缩略图
          const cacheKey = `${fpsStep}:${Math.round(t * 1000)}`
          if (frameCacheRef.current.has(cacheKey)) continue
          try {
            if (video.readyState < 1) {
              await new Promise<void>((resolve) => {
                const done = (): void => {
                  video.removeEventListener('loadeddata', done)
                  resolve()
                }
                video.addEventListener('loadeddata', done)
              })
            }
            if (gen !== filmstripGenRef.current) return
            const url = await seekAndCaptureFrame(video, t, 400)
            if (gen !== filmstripGenRef.current) return
            frameCacheRef.current.set(cacheKey, url)
            if (frameCacheRef.current.size > 480) {
              const keys = Array.from(frameCacheRef.current.keys()).slice(0, 160)
              for (const k of keys) frameCacheRef.current.delete(k)
            }
            setFilmstrip({
              which,
              centerTime: edge,
              items: buildFilmstripItems(edge)
            })
          } catch {
            /* skip missing frame */
          }
        }
      })()
    },
    [buildFilmstripItems, mediaUrl, duration, ensureScrubReady]
  )

  const scheduleFilmstrip = useCallback(
    (which: 'in' | 'out', centerTime: number) => {
      if (filmstripRafRef.current) cancelAnimationFrame(filmstripRafRef.current)
      filmstripRafRef.current = requestAnimationFrame(() => {
        refreshFilmstrip(which, centerTime)
      })
    },
    [refreshFilmstrip]
  )

  const exitFineTune = useCallback(() => {
    filmstripGenRef.current++
    setFineTuneWhich(null)
    setFilmstrip(null)
  }, [])

  const applyFineTuneEdge = useCallback(
    (
      which: 'in' | 'out',
      nextTime: number,
      opts?: { preview?: boolean; refreshStrip?: boolean; toastOnFail?: boolean }
    ) => {
      const preview = opts?.preview !== false
      const refreshStrip = opts?.refreshStrip !== false
      // 方向键/步进变更时作废「播放结束后按旧边沿刷选帧」
      filmstripAfterPlayTokenRef.current++
      let liveStart = snapToFrame(Math.min(selStartRef.current, selEndRef.current), stepFps)
      let liveEnd = snapToFrame(Math.max(selStartRef.current, selEndRef.current), stepFps)
      const moved = tryMoveSelectionEdge(
        which,
        nextTime,
        liveStart,
        liveEnd,
        remaining,
        stepFps,
        clipExports
      )
      if (!moved.ok) {
        if (opts?.toastOnFail) showToast(moved.reason)
        return null
      }
      liveStart = snapToFrame(moved.start, stepFps)
      liveEnd = snapToFrame(moved.end, stepFps)
      selStartRef.current = liveStart
      selEndRef.current = liveEnd
      setSelStart(liveStart)
      setSelEnd(liveEnd)
      ensureTimelineFocusCovers(liveStart, liveEnd)
      setFineTuneWhich(which)
      const edge = which === 'in' ? liveStart : liveEnd
      if (preview) {
        ensureScrubReady()
        if (which === 'in') {
          const cacheKey = `${stepFps}:${Math.round(edge * 1000)}`
          setStillFrameUrl(frameCacheRef.current.get(cacheKey) ?? null)
          void seekPreviewFrame(edge, { force: true })
        } else {
          scheduleFilmstrip(which, edge)
          try {
            videoRef.current?.pause()
          } catch {
            /* ignore */
          }
        }
      }
      if (refreshStrip) {
        ensureScrubReady()
        scheduleFilmstrip(which, edge)
      }
      return edge
    },
    [
      remaining,
      clipExports,
      seekPreviewFrame,
      scheduleFilmstrip,
      stepFps,
      ensureTimelineFocusCovers,
      ensureScrubReady,
      showToast
    ]
  )

  /** 点击选帧区：立刻用缩略图盖住播放区，并同步底层 currentTime（不自动播放） */
  const selectFilmstripFrame = useCallback(
    (which: 'in' | 'out', time: number, thumbUrl: string | null) => {
      const snapped = snapToFrame(time, stepFpsRef.current)
      // 1) 立刻换画面：用已有缩略图覆盖播放区
      if (thumbUrl) setStillFrameUrl(thumbUrl)

      const edge = applyFineTuneEdge(which, snapped, { preview: false, refreshStrip: false })
      const showAt = edge ?? snapped

      void (async () => {
        const gen = ++playbackGenRef.current
        filmstripGenRef.current++
        previewEndRef.current = null

        const v = videoRef.current
        const scrub = scrubVideoRef.current
        if (scrub) {
          try {
            scrub.pause()
          } catch {
            /* ignore */
          }
        }
        if (!v) {
          scheduleFilmstrip(which, showAt)
          return
        }

        try {
          v.pause()
        } catch {
          /* ignore */
        }

        try {
          // 2) 同步底层时间：微偏再吸回，逼出解码帧
          const nudge = showAt < 0.05 ? showAt + 0.05 : Math.max(0, showAt - 0.05)
          await seekVideo(v, nudge)
          if (gen !== playbackGenRef.current) return
          await seekVideo(v, showAt)
          if (gen !== playbackGenRef.current) return
          v.pause()
          setCurrentTime(v.currentTime)

          // 3) 若无缩略图或需更高清，从主视频抓一帧替换覆盖层
          try {
            const hi = await seekAndCaptureFrame(v, showAt, 960)
            if (gen === playbackGenRef.current) setStillFrameUrl(hi)
          } catch {
            /* 保留缩略图覆盖 */
          }
        } catch {
          setCurrentTime(showAt)
        }

        if (gen === playbackGenRef.current) {
          scheduleFilmstrip(which, showAt)
        }
      })()
    },
    [applyFineTuneEdge, scheduleFilmstrip]
  )

  const nudgeFineTune = useCallback(
    (deltaFrames: number) => {
      const which = fineTuneWhichRef.current
      if (!which) return
      const edge = which === 'in' ? selStartRef.current : selEndRef.current
      const fpsStep = stepFpsRef.current
      applyFineTuneEdge(which, stepByFrames(edge, fpsStep, deltaFrames), { toastOnFail: true })
    },
    [applyFineTuneEdge]
  )

  useEffect(() => {
    if (stepFpsBootRef.current) {
      stepFpsBootRef.current = false
      return
    }
    frameCacheRef.current.clear()
    const which = fineTuneWhichRef.current
    if (!which) return
    const edge = which === 'in' ? selStartRef.current : selEndRef.current
    // 按新步进重吸附，并同步播放画面 + 选帧间距
    applyFineTuneEdge(which, snapToFrame(edge, stepFps))
    // 仅在步进变化时重同步；不要因 applyFineTuneEdge 引用变化误触发
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stepFps only
  }, [stepFps])

  const current = videos[index] ?? null
  /** 按扩展名自动识别：图片无播放界面，仅分类 + 画面裁切 */
  const currentIsImage = Boolean(
    current && (current.mediaKind === 'image' || isImagePath(current.path))
  )

  const visibleIndices = useMemo(() => {
    return videos
      .map((v, i) => ({ v, i }))
      .filter(({ v, i }) => {
        if (onlyIncomplete && !videoShowsAsIncomplete(v, i, index, remainingHints)) return false
        if (mediaKindFilter === 'image' && !itemIsImage(v)) return false
        if (mediaKindFilter === 'video' && itemIsImage(v)) return false
        return true
      })
      .map(({ i }) => i)
  }, [videos, onlyIncomplete, index, mediaKindFilter, remainingHints])

  const listHasBothKinds = useMemo(() => {
    let hasVideo = false
    let hasImage = false
    for (const v of videos) {
      if (itemIsImage(v)) hasImage = true
      else hasVideo = true
      if (hasVideo && hasImage) return true
    }
    return false
  }, [videos])

  const [thumbScrollTop, setThumbScrollTop] = useState(0)
  const [thumbViewportH, setThumbViewportH] = useState(600)

  useEffect(() => {
    const el = thumbGridRef.current
    if (!el) return
    const sync = (): void => {
      setThumbViewportH(el.clientHeight)
      setThumbScrollTop(el.scrollTop)
    }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', sync)
      ro.disconnect()
    }
  }, [videos.length, sidebarWidth])

  const thumbVirtual = useMemo(() => {
    const gap = 10
    const caption = 44
    const itemH = thumbSize + caption + gap
    const cols = Math.max(1, Math.floor((Math.max(200, sidebarWidth - 28) + gap) / (thumbSize + gap)))
    const indices = visibleIndices
    const rows = Math.ceil(indices.length / cols)
    const totalH = Math.max(itemH, rows * itemH)
    const startRow = Math.max(0, Math.floor(thumbScrollTop / itemH) - 1)
    const endRow = Math.min(rows, Math.ceil((thumbScrollTop + thumbViewportH) / itemH) + 1)
    const start = startRow * cols
    const end = Math.min(indices.length, endRow * cols)
    const slice = indices.slice(start, end).map((videoIndex, local) => ({
      videoIndex,
      offset: start + local
    }))
    return { cols, itemH, totalH, start, slice }
  }, [visibleIndices, thumbSize, sidebarWidth, thumbScrollTop, thumbViewportH])

  const selectedVideos = useMemo(
    () => videos.filter((v) => selectedIds.has(v.id)),
    [videos, selectedIds]
  )

  useEffect(() => {
    try {
      localStorage.setItem(LS_THUMB, String(thumbSize))
    } catch {
      /* ignore */
    }
  }, [thumbSize])

  useEffect(() => {
    try {
      localStorage.setItem(LS_SIDEBAR, String(sidebarWidth))
    } catch {
      /* ignore */
    }
  }, [sidebarWidth])

  useEffect(() => {
    const el = appBodyRef.current
    if (!el) return
    const apply = (): void => {
      const w = el.clientWidth
      setPaneBodyW(w)
      setSidebarWidth((prev) => {
        const maxFill = Math.max(0, w - PANE_SPLITTER_W)
        if (prev <= 0) return 0
        // 已收起播放区时跟随窗口；打开态不因接近右缘被误判为收起
        if (prev >= maxFill - 1) return maxFill
        const openMax = Math.min(
          SIDEBAR_WIDTH_MAX,
          Math.max(SIDEBAR_WIDTH_MIN, maxFill - MAIN_COLLAPSE_SNAP - 8)
        )
        return clamp(prev, SIDEBAR_WIDTH_MIN, openMax)
      })
    }
    apply()
    const ro = new ResizeObserver(() => apply())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(LS_FILMSTRIP_HEIGHT, String(filmstripHeight))
    } catch {
      /* ignore */
    }
  }, [filmstripHeight])

  const maxFilmstripHeight = useCallback((): number => {
    const wrap = playerWrapRef.current
    if (!wrap) return FILMSTRIP_HEIGHT_MIN
    const cs = getComputedStyle(wrap)
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const contentH = Math.max(0, wrap.clientHeight - padY)
    const editH =
      timelineRef.current?.offsetHeight ?? timelineFooterRef.current?.offsetHeight ?? 160
    // 选帧区可尽量放大，只保证：播放区 ≥ VIDEO_STAGE_MIN、剪辑区完整可见
    const available = contentH - VIDEO_STAGE_MIN - PLAYER_SPLITTER_H - editH
    return Math.max(FILMSTRIP_HEIGHT_MIN, available)
  }, [])

  /** 窗口变矮时收缩选帧区，保证播放区与剪辑区不被挤没 */
  useEffect(() => {
    const clampHeight = (): void => {
      const max = maxFilmstripHeight()
      setFilmstripHeight((h) => clamp(h, FILMSTRIP_HEIGHT_MIN, max))
    }
    clampHeight()
    window.addEventListener('resize', clampHeight)
    return () => window.removeEventListener('resize', clampHeight)
  }, [maxFilmstripHeight])

  /** Ctrl+滚轮：平滑缩放缩略图（passive:false 才能拦截浏览器缩放） */
  useEffect(() => {
    const el = thumbGridRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()
      let dy = e.deltaY
      if (e.deltaMode === 1) dy *= 16
      if (e.deltaMode === 2) dy *= el.clientHeight
      // 触控板捏合 delta 小且连续；鼠标滚轮 delta 大，限制单次幅度
      const sensitivity = Math.abs(dy) < 40 ? 0.012 : 0.0035
      const factor = clamp(Math.exp(-dy * sensitivity), 0.82, 1.22)
      setThumbSize((s) => clamp(Math.round(s * factor), THUMB_SIZE_MIN, THUMB_SIZE_MAX))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const paneBodyWidth = useCallback((): number => {
    if (paneBodyW > 0) return paneBodyW
    return appBodyRef.current?.clientWidth || Math.max(640, window.innerWidth)
  }, [paneBodyW])

  const clampSidebarWidth = useCallback(
    (raw: number): number => {
      const maxFill = Math.max(0, paneBodyWidth() - PANE_SPLITTER_W)
      if (raw <= SIDEBAR_COLLAPSE_SNAP) return 0
      if (raw >= maxFill - MAIN_COLLAPSE_SNAP) return maxFill
      const openMax = Math.min(
        SIDEBAR_WIDTH_MAX,
        Math.max(SIDEBAR_WIDTH_MIN, maxFill - MAIN_COLLAPSE_SNAP - 8)
      )
      return clamp(raw, SIDEBAR_WIDTH_MIN, openMax)
    },
    [paneBodyWidth]
  )

  const sidebarCollapsed = sidebarWidth <= 0
  const mainCollapsed =
    paneBodyW > 0
      ? sidebarWidth >= paneBodyW - PANE_SPLITTER_W - 1
      : sidebarWidth > SIDEBAR_WIDTH_MAX

  const startSidebarResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    document.body.classList.add('resizing-panes')
    const move = (ev: MouseEvent): void => {
      setSidebarWidth(clampSidebarWidth(startW + (ev.clientX - startX)))
    }
    const up = (): void => {
      document.body.classList.remove('resizing-panes')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const startPlayerSplitResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = filmstripHeight
    document.body.classList.add('resizing-player-split')
    const move = (ev: MouseEvent): void => {
      // 分界线在选帧区上方：向上拖 = 放大选帧区；向下拖 = 缩小；下限防折叠
      const maxH = maxFilmstripHeight()
      setFilmstripHeight(clamp(startH - (ev.clientY - startY), FILMSTRIP_HEIGHT_MIN, maxH))
    }
    const up = (): void => {
      document.body.classList.remove('resizing-player-split')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** 拖动时间轴播放头（白线）查看进度 */
  const startPlayheadDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!mediaUrl || !(duration > 0)) return

    const seekFromClientX = (clientX: number): void => {
      const el = trackRef.current
      const v = videoRef.current
      if (!el || !v) return
      const rect = el.getBoundingClientRect()
      const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1)
      const view = timelineViewRef.current
      const t = snapToFrame(view.start + ratio * view.span, fps)
      previewEndRef.current = null
      setStillFrameUrl(null)
      try {
        v.currentTime = t
      } catch {
        /* ignore */
      }
      setCurrentTime(t)
    }

    document.body.classList.add('dragging-playhead')
    seekFromClientX(e.clientX)
    const move = (ev: MouseEvent): void => seekFromClientX(ev.clientX)
    const up = (): void => {
      document.body.classList.remove('dragging-playhead')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  useEffect(() => {
    const offBusy = window.api.onBusyChanged(setBusy)
    const offProgress = window.api.onBusyProgress(setBusyProgress)
    const offClose = window.api.onRequestClose(() => {
      if (dirtyRef.current) {
        setConfirmModal({
          title: '有未完成的编辑',
          message:
            '当前视频还有未点「完成」的剪辑会话。直接退出不会改写原片；下次打开可选择恢复或丢弃已导出片段。',
          confirmText: '仍要退出',
          onConfirm: () => {
            window.api.confirmQuit(true)
          }
        })
      } else {
        window.api.confirmQuit(true)
      }
    })
    const offUpdate = window.api.onUpdateAvailable((info) => {
      const ver = (info as { version?: string })?.version
      setUpdateBanner(ver ? `发现新版本 ${ver}` : '发现新版本')
    })
    const offDownloaded = window.api.onUpdateDownloaded(() => {
      setUpdateBanner('更新已下载，重启即可安装')
    })
    const offUpdateError = window.api.onUpdateError((message) => {
      // 主进程已过滤首发无 Release 等良性情况；此处再兜一层，避免误弹 toast
      if (/No published versions on GitHub|404|ENOTFOUND|ETIMEDOUT|net::ERR_/i.test(message || '')) {
        return
      }
      reportClientError('updater', message)
      showToast(message ? `检查更新失败：${message}` : '检查更新失败')
    })

    void (async () => {
      try {
        const info = await window.api.getStartupInfo()
        setAppVersion(info.version || '')

        let pendingSessions: SessionState[] = []
        try {
          pendingSessions = await window.api.listPendingSessions()
        } catch (err) {
          reportClientError('listPendingSessions', err)
        }

        if (info.showWhatsNew) {
          setWhatsNewModal({
            title: info.whatsNewTitle,
            lines: info.whatsNewLines || [],
            version: info.version
          })
          pendingRecoverSessionsRef.current =
            pendingSessions.length > 0 ? pendingSessions : null
        } else if (pendingSessions.length > 0) {
          // 无更新说明时稍延后，避免挡首屏
          window.setTimeout(() => {
            setRecoverModal({ sessions: pendingSessions, index: 0 })
          }, 400)
        }
      } catch (err) {
        reportClientError('getStartupInfo', err)
      }
    })()

    const onWindowError = (ev: ErrorEvent): void => {
      reportClientError('window.error', ev.error || ev.message, {
        filename: ev.filename,
        lineno: ev.lineno,
        colno: ev.colno
      })
    }
    const onUnhandled = (ev: PromiseRejectionEvent): void => {
      reportClientError('window.unhandledrejection', ev.reason)
    }
    window.addEventListener('error', onWindowError)
    window.addEventListener('unhandledrejection', onUnhandled)

    return () => {
      window.removeEventListener('error', onWindowError)
      window.removeEventListener('unhandledrejection', onUnhandled)
      offBusy()
      offProgress()
      offClose()
      offUpdate()
      offDownloaded()
      offUpdateError()
    }
  }, [])

  const loadVideoAt = useCallback(
    async (i: number, list = videos) => {
      const item = list[i]
      const gen = ++loadGenRef.current
      if (!item) {
        setMediaUrl('')
        setVideoNatural({ w: 0, h: 0 })
        return
      }
      setIndex(i)
      setStatus(`加载：${item.name}`)
      setExportPreviewUrl(null)
      // 立刻清空旧 URL，避免「已切到图片模式但仍用上一个视频 mediaUrl」导致 img.onError 误报
      setMediaUrl('')
      setStillFrameUrl(null)
      try {
        // 先 probe / 会话，再挂 media URL，避免 Windows 上大文件解码与探测抢 IO 卡死界面
        const probe = await window.api.probe(item.path)
        if (gen !== loadGenRef.current) return
        const isImage = item.mediaKind === 'image' || isImagePath(item.path)
        const mediaDuration = isImage
          ? IMAGE_TIMELINE_SECONDS
          : probe.duration > 0
            ? probe.duration
            : 0
        setDuration(mediaDuration)
        setFps(typeof probe.fps === 'number' && probe.fps > 1 ? probe.fps : 25)
        if (typeof probe.width === 'number' && typeof probe.height === 'number') {
          setVideoNatural({
            w: probe.width > 0 ? probe.width : 0,
            h: probe.height > 0 ? probe.height : 0
          })
        }
        const session = await window.api.loadSession(item.path)
        if (gen !== loadGenRef.current) return
        if (session && session.exports.length > 0) {
          // 精确段用于可剪剩余区；推算段只用于展示
          const precise = session.exports.filter((e) => !e.approx)
          const rem = isImage
            ? [{ start: 0, end: mediaDuration }]
            : computeRemainingFromExports(mediaDuration, precise)
          setRemaining(rem)
          syncRemainingHint(item.path, totalDuration(rem))
          setClipExports(session.exports)
          setSelectedExportPath(null)
          setUndoCount(session.undoStack.length)
          // 仅当无可剪剩余时视为纯回看；已完成但仍有剩余段时应可继续编辑
          const reviewOnly = !isImage && rem.length === 0
          dirtyRef.current = false
          completedRef.current = item.completed
          if (reviewOnly && !isImage) {
            // 回看：先不铺选区蒙层，避免挡住分类色块
            const first = session.exports[0]
            setSelStart(first.start)
            setSelEnd(first.start)
          } else {
            const span = selectionSpanFromRemaining(rem, mediaDuration)
            setSelStart(span.start)
            setSelEnd(span.end)
          }
        } else {
          const rem = [{ start: 0, end: mediaDuration }]
          setRemaining(rem)
          syncRemainingHint(item.path, totalDuration(rem))
          setClipExports([])
          setSelectedExportPath(null)
          setUndoCount(0)
          dirtyRef.current = false
          completedRef.current = item.completed
          const span = selectionSpanFromRemaining(
            [{ start: 0, end: mediaDuration }],
            mediaDuration
          )
          setSelStart(span.start)
          setSelEnd(span.end)
        }
        setUiUndoStack([])
        setFineTuneWhich(null)
        setFilmstrip(null)
        setStillFrameUrl(null)
        setTimelineFocus(null)
        setTimelineMarkers([])
        setCrop(FULL_CROP)
        setCropActive(false)
        setCropCommitted(false)
        setCurrentTime(0)
        setCategoryInput(defaultCategoryFromDir(item.parentDirName))
        if (session && session.exports.length > 0) {
          const approxN = session.exports.filter((e) => e.approx).length
          setStatus(
            approxN > 0
              ? `已识别分类 ${session.exports.length} 段（含 ${approxN} 段历史推算）· 点击色块播放`
              : isImage
                ? `已保存 ${session.exports.length} 次分类 · 可继续裁切 / 分类`
                : `已识别分类 ${session.exports.length} 段 · 点击色块播放`
          )
        } else if (item.completed) {
          setStatus('已完成（无时间轴记录）')
        } else {
          setStatus('')
        }

        playSourcePathRef.current = item.path
        previewProxyTriedRef.current = false
        let playPath = item.path
        if (!isImage && probe.needsPreviewProxy) {
          setStatus('正在生成兼容预览…')
          const proxy = await window.api.ensurePreviewProxy(item.path)
          if (gen !== loadGenRef.current) return
          playPath = proxy.path
          previewProxyTriedRef.current = true
          if (proxy.proxied) {
            showToast('已使用兼容预览（原片为 HEVC）')
          }
        }
        const url = await window.api.getMediaUrl(playPath)
        if (gen !== loadGenRef.current) return
        setMediaUrl(url)
        if (!isImage && probe.needsPreviewProxy) setStatus('')
      } catch (err: unknown) {
        if (gen !== loadGenRef.current) return
        setMediaUrl('')
        showToast(`无法加载：${String(err)}`)
        setStatus('加载失败')
      }
    },
    [videos, showToast]
  )

  /** 真正写入列表并打开首个媒体（合并去重，不覆盖已有项） */
  const commitImportedList = useCallback(
    async (items: VideoItem[], kindFilter: MediaKindFilter = 'all') => {
      if (items.length === 0) {
        showToast('未找到视频或图片文件')
        return
      }
      setMediaKindFilter(kindFilter)
      setSelectedIds(new Set())
      selectAnchorRef.current = null
      setBatchUndoItems(null)

      const prevSnapshot = videos
      const byPath = new Map(prevSnapshot.map((v) => [v.path, v]))
      let added = 0
      for (const item of items) {
        const existing = byPath.get(item.path)
        if (existing) {
          byPath.set(item.path, { ...existing, ...item, id: existing.id })
        } else {
          byPath.set(item.path, item)
          added++
        }
      }
      const merged = Array.from(byPath.values()).sort((a, b) => compareMediaPaths(a.path, b.path))
      setVideos(merged)

      if (added > 0) {
        showToast(`已追加 ${added} 个新媒体${prevSnapshot.length ? `（列表共 ${merged.length} 个）` : ''}`)
      } else if (prevSnapshot.length > 0) {
        showToast('导入项均已在列表中，已刷新状态')
      } else {
        const videoN = merged.filter((v) => !itemIsImage(v)).length
        const imageN = merged.length - videoN
        const classified = merged.filter((v) => v.completed).length
        const parts: string[] = []
        if (videoN) parts.push(`${videoN} 个视频`)
        if (imageN) parts.push(`${imageN} 张图片`)
        const summary = parts.join('、') || `${merged.length} 个媒体`
        if (classified > 0) {
          showToast(
            `已加载 ${summary}，其中 ${classified} 个已有分类（取消「只看未完成」可回看）`
          )
        } else {
          showToast(`已加载 ${summary}`)
        }
      }

      const currentPath = prevSnapshot[index]?.path
      const stillIdx = currentPath ? merged.findIndex((v) => v.path === currentPath) : -1
      const firstNewItem = items.find((v) => !prevSnapshot.some((p) => p.path === v.path))
      const firstIncomplete = merged.findIndex((v) => !v.completed)

      if (stillIdx >= 0) {
        if (stillIdx !== index) setIndex(stillIdx)
      } else if (firstNewItem) {
        const newIdx = merged.findIndex((v) => v.path === firstNewItem.path)
        if (newIdx >= 0) await loadVideoAt(newIdx, merged)
      } else if (firstIncomplete >= 0) {
        await loadVideoAt(firstIncomplete, merged)
      } else if (merged.length > 0 && prevSnapshot.length === 0) {
        await loadVideoAt(0, merged)
      }

      void window.api.refreshCompletedFlags(merged).then((next) => {
        if (!Array.isArray(next) || next.length === 0) return
        setVideos((prev) => {
          const flags = new Map(next.map((v) => [v.path, v]))
          return prev.map((v) => {
            const n = flags.get(v.path)
            return n ? { ...v, completed: n.completed } : v
          })
        })
      })
      void refreshRemainingHints(merged)
    },
    [loadVideoAt, showToast, videos, index, refreshRemainingHints]
  )

  /** 对话框 / 拖放导入：若同时含视频与图片，先询问加载范围 */
  const applyImportedList = useCallback(
    async (items: VideoItem[]) => {
      if (items.length === 0) {
        showToast('未找到视频或图片文件')
        return
      }
      const videoItems = items.filter((v) => !itemIsImage(v))
      const imageItems = items.filter((v) => itemIsImage(v))
      if (videoItems.length > 0 && imageItems.length > 0) {
        setImportChoiceModal({
          items,
          videoCount: videoItems.length,
          imageCount: imageItems.length
        })
        return
      }
      await commitImportedList(items, 'all')
    },
    [commitImportedList, showToast]
  )

  const resolveImportChoice = useCallback(
    async (choice: 'video' | 'image' | 'both') => {
      const modal = importChoiceModal
      if (!modal) return
      setImportChoiceModal(null)
      if (choice === 'video') {
        await commitImportedList(
          modal.items.filter((v) => !itemIsImage(v)),
          'all'
        )
        return
      }
      if (choice === 'image') {
        await commitImportedList(
          modal.items.filter((v) => itemIsImage(v)),
          'all'
        )
        return
      }
      await commitImportedList(modal.items, 'all')
    },
    [importChoiceModal, commitImportedList]
  )

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (busy) {
        showToast('正在处理中，无法导入')
        return
      }
      const items = await window.api.importUserPaths(paths)
      await applyImportedList(items)
    },
    [busy, applyImportedList, showToast]
  )

  const openViaDialog = useCallback(async () => {
    if (busy) {
      showToast('正在处理中，无法导入')
      return
    }
    const defaultPath = dialogDefaultPathFor(current, videos)
    const items = await window.api.pickMediaFiles(defaultPath ? { defaultPath } : {})
    if (!items.length) return
    await applyImportedList(items)
  }, [busy, applyImportedList, showToast, current, videos])

  const toggleSelect = useCallback((id: string, listIndex: number) => {
    selectAnchorRef.current = listIndex
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setThumbPreviewIds((prev) => {
      if (!prev.has(id)) return prev
      // 取消选中时停掉该条小窗预览
      if (prev.size === 1) return new Set()
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  /** Shift+单击：从锚点连选到当前项（含中间全部）。锚点不随二次 Shift 点击移动。 */
  const rangeSelect = useCallback(
    (toIndex: number) => {
      if (toIndex < 0 || toIndex >= videos.length) return

      let anchorIdx = selectAnchorRef.current
      if (anchorIdx == null || anchorIdx < 0 || anchorIdx >= videos.length) {
        anchorIdx = index
      }
      if (selectAnchorRef.current == null) {
        selectAnchorRef.current = anchorIdx
      }

      const a = Math.min(anchorIdx, toIndex)
      const b = Math.max(anchorIdx, toIndex)
      const next = new Set<string>()
      for (let i = a; i <= b; i++) {
        const item = videos[i]
        if (item) next.add(item.id)
      }
      setSelectedIds(next)
    },
    [videos, index]
  )

  /** 松开主预览 / 缩略图预览句柄，避免 Windows rename/move EBUSY */
  const releaseMediaHandles = useCallback(async (): Promise<void> => {
    setThumbPreviewIds(new Set())
    setExportPreviewUrl(null)
    setStillFrameUrl(null)
    setMediaUrl('')
    for (const el of [videoRef.current, scrubVideoRef.current]) {
      if (!el) continue
      try {
        el.pause()
        el.removeAttribute('src')
        el.load()
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((r) => window.setTimeout(r, MEDIA_RELEASE_MS))
  }, [])

  /** 完成/撤销完成后重新挂可播 URL（Win HEVC 走代理） */
  const reloadPlayableMedia = useCallback(async (sourcePath: string): Promise<void> => {
    playSourcePathRef.current = sourcePath
    previewProxyTriedRef.current = false
    try {
      const probe = await window.api.probe(sourcePath)
      if (probe.needsPreviewProxy) {
        previewProxyTriedRef.current = true
        const proxy = await window.api.ensurePreviewProxy(sourcePath, false, true)
        setMediaUrl(proxy.url)
        return
      }
    } catch {
      /* fall through to raw url */
    }
    const url = await window.api.getMediaUrl(sourcePath)
    setMediaUrl(url)
  }, [])

  const openBatchModal = useCallback(async () => {
    if (selectedVideos.length === 0) {
      showToast(`请先多选视频（${MOD_KEY}+单击或 Shift+单击）`)
      return
    }
    const first = selectedVideos[0]
    setBatchCategory(defaultCategoryFromDir(first.parentDirName))
    setBatchModal(true)
  }, [selectedVideos, showToast])

  const runBatchClassify = useCallback(
    async (paths: string[], category: string, opts?: ClassifyDestOpts) => {
      if (busy || paths.length === 0) return
      lastClassifyOptsRef.current = opts
      setStatus(`正在批量分类 ${paths.length} 个视频…`)
      try {
        // 松开主预览与缩略图小窗，避免 Windows rename/move 失败
        const currentPath = videos[index]?.path
        const touchesCurrent =
          Boolean(currentPath) &&
          paths.some((p) => normMediaPath(p) === normMediaPath(currentPath!))
        if (touchesCurrent || thumbPreviewIds.size > 0) {
          await releaseMediaHandles()
        }

        const pathSet = new Set(paths.map((p) => normMediaPath(p)))
        const selectedSnapshot = videos.filter((v) => pathSet.has(normMediaPath(v.path)))
        const { results, canUndo, cancelled } = await window.api.batchClassify(
          paths,
          category,
          opts
        )
        const okPaths = new Set(
          results.filter((r) => r.ok).map((r) => normMediaPath(r.path))
        )
        const currentMoved = currentPath
          ? okPaths.has(normMediaPath(currentPath))
          : false

        const restoredCandidates = selectedSnapshot.filter((v) =>
          okPaths.has(normMediaPath(v.path))
        )
        if (canUndo) {
          setBatchUndoItems((prev) => {
            const map = new Map((prev || []).map((v) => [v.path, v]))
            for (const v of restoredCandidates) map.set(v.path, v)
            return Array.from(map.values())
          })
        } else {
          setBatchUndoItems(null)
        }

        const nextList = videos.filter((v) => !okPaths.has(normMediaPath(v.path)))
        setVideos(nextList)
        setSelectedIds(new Set())
        selectAnchorRef.current = null

        setBatchResultModal({
          category,
          results,
          canUndo,
          cancelled
        })

        if (cancelled) {
          showToast(
            `已取消：成功移动 ${okPaths.size} 个。已移动项可用撤回还原；未处理项未改动`
          )
        }

        if (currentMoved) {
          dirtyRef.current = false
          const nextIdx = nextList.findIndex((v) => !v.completed)
          if (nextIdx >= 0) await loadVideoAt(nextIdx, nextList)
          else if (nextList.length > 0) await loadVideoAt(0, nextList)
          else {
            setMediaUrl('')
            setIndex(0)
            setStatus('批量分类完成（列表已空）')
          }
        } else {
          const stillIdx = nextList.findIndex(
            (v) => currentPath && normMediaPath(v.path) === normMediaPath(currentPath)
          )
          if (stillIdx >= 0 && stillIdx !== index) setIndex(stillIdx)
          setStatus(cancelled ? '批量分类已取消' : '批量分类完成')
        }
      } catch (err) {
        showToast(String(err))
        setStatus('批量分类失败')
      }
    },
    [busy, videos, index, loadVideoAt, showToast, releaseMediaHandles, thumbPreviewIds.size]
  )

  const confirmBatchClassify = useCallback(async () => {
    const category = batchCategory.trim()
    if (!category) {
      showToast('请输入类别')
      return
    }
    if (busy || selectedVideos.length === 0) return
    const paths = selectedVideos.map((v) => v.path)
    const categorizedCount = selectedVideos.filter((v) => v.isCategoryCopy).length
    setBatchModal(false)

    if (categorizedCount > 0) {
      const savedMode = loadReclassifyMode()
      const savedDir = localStorage.getItem(LS_RECLASSIFY_CUSTOM_DIR) || ''
      const dontAsk = loadStoredBool(LS_RECLASSIFY_DONT_ASK, false)
      if (dontAsk && (savedMode !== 'custom' || savedDir)) {
        await runBatchClassify(paths, category, {
          reclassifyMode: savedMode,
          customDestDir: savedMode === 'custom' ? savedDir : undefined
        })
        return
      }
      setReclassifyMode(savedMode)
      setReclassifyCustomDir(savedDir)
      setReclassifyDontAsk(false)
      setReclassifyDestModal({ purpose: 'batch', category, paths, categorizedCount })
      return
    }

    await runBatchClassify(paths, category)
  }, [batchCategory, busy, selectedVideos, showToast, runBatchClassify])

  const runSaveClipExport = useCallback(
    async (payload: PendingSaveClip, opts?: ClassifyDestOpts): Promise<void> => {
      if (savingRef.current || busy) {
        showToast('正在保存，请稍候…')
        return
      }
      savingRef.current = true
      const { category, isImage, saveModal: modal, sourcePath, duration: mediaDuration } = payload
      ignoreEnterOpenUntilRef.current = performance.now() + 600
      setSaveModal(null)
      setStatus(isImage ? '正在保存图片…' : '正在导出片段…')
      try {
        const classifyFields = opts
          ? {
              reclassifyMode: opts.reclassifyMode,
              customDestDir: opts.customDestDir
            }
          : {}
        const result = isImage
          ? await window.api.exportImage({
              sourcePath,
              category,
              crop: modal.crop,
              cropActive: modal.cropActive,
              ...classifyFields
            })
          : await window.api.exportClip({
              sourcePath,
              start: modal.start,
              end: modal.end,
              category,
              crop: modal.crop,
              cropActive: modal.cropActive,
              duration: mediaDuration,
              ...classifyFields
            })
        const session = result.session
        const precise = session.exports.filter((e) => !e.approx)
        const rem = isImage
          ? [{ start: 0, end: session.duration || IMAGE_TIMELINE_SECONDS }]
          : session.duration > 0
            ? computeRemainingFromExports(session.duration, precise)
            : session.remainingRanges
        setRemaining(rem)
        syncRemainingHint(sourcePath, totalDuration(rem))
        setClipExports(session.exports)
        setSelectedExportPath(null)
        setExportPreviewUrl(null)
        setUndoCount(session.undoStack.length)
        dirtyRef.current = true
        if (result.message) showToast(result.message)
        else showToast(`已保存：${result.outputPath}`)
        setStatus('导出完成')
        clearTimelineFocus()

        if (!isImage && totalDuration(rem) <= 0.05) {
          const ok = await finishCurrentRef.current()
          if (ok) await goRelativeRef.current(1)
        } else {
          const span = selectionSpanFromRemaining(rem)
          setSelStart(span.start)
          setSelEnd(span.end)
          setCrop(FULL_CROP)
          setCropActive(false)
          setCropCommitted(false)
        }
      } catch (err) {
        reportClientError(isImage ? 'exportImage' : 'exportClip', err, {
          path: sourcePath,
          category
        })
        showToast(errText(err))
        setStatus('导出失败')
      } finally {
        savingRef.current = false
      }
    },
    [busy, showToast, syncRemainingHint, clearTimelineFocus]
  )

  const confirmReclassifyDest = useCallback(async () => {
    const modal = reclassifyDestModal
    if (!modal || busy) return
    if (reclassifyMode === 'custom' && !reclassifyCustomDir.trim()) {
      showToast('请先选择目标文件夹')
      return
    }
    const opts: ClassifyDestOpts = {
      reclassifyMode,
      customDestDir: reclassifyMode === 'custom' ? reclassifyCustomDir.trim() : undefined
    }
    try {
      localStorage.setItem(LS_RECLASSIFY_MODE, reclassifyMode)
      if (reclassifyCustomDir.trim()) {
        localStorage.setItem(LS_RECLASSIFY_CUSTOM_DIR, reclassifyCustomDir.trim())
      }
      if (reclassifyDontAsk) {
        localStorage.setItem(LS_RECLASSIFY_DONT_ASK, '1')
        setReclassifyPrefDontAsk(true)
      }
    } catch {
      /* ignore */
    }
    setReclassifyDestModal(null)
    await runBatchClassify(modal.paths, modal.category, opts)
  }, [
    reclassifyDestModal,
    busy,
    reclassifyMode,
    reclassifyCustomDir,
    reclassifyDontAsk,
    showToast,
    runBatchClassify
  ])

  const pickReclassifyCustomDir = useCallback(async () => {
    const defaultPath =
      reclassifyCustomDir.trim() ||
      dialogDefaultPathFor(current, videos) ||
      undefined
    try {
      const dir = await window.api.pickDirectory({
        title: '选择二次分类目标文件夹',
        defaultPath
      })
      if (dir) setReclassifyCustomDir(dir)
    } catch (err) {
      showToast(String(err))
    }
  }, [reclassifyCustomDir, current, videos, showToast])

  const clearReclassifyDontAsk = useCallback(() => {
    try {
      localStorage.setItem(LS_RECLASSIFY_DONT_ASK, '0')
    } catch {
      /* ignore */
    }
    setReclassifyPrefDontAsk(false)
    showToast('已恢复二次分类落点询问')
  }, [showToast])

  const retryBatchFailed = useCallback(
    async (failedPaths: string[], category: string) => {
      if (busy || failedPaths.length === 0) return
      setBatchResultModal(null)
      setStatus(`正在重试 ${failedPaths.length} 个失败项…`)
      try {
        const currentPath = videos[index]?.path
        const touchesCurrent =
          Boolean(currentPath) &&
          failedPaths.some((p) => normMediaPath(p) === normMediaPath(currentPath!))
        if (touchesCurrent || thumbPreviewIds.size > 0) {
          await releaseMediaHandles()
        }

        const { results, canUndo, cancelled } = await window.api.batchClassify(
          failedPaths,
          category,
          lastClassifyOptsRef.current
        )
        const okPaths = new Set(
          results.filter((r) => r.ok).map((r) => normMediaPath(r.path))
        )
        const okItems = videos.filter((v) => okPaths.has(normMediaPath(v.path)))
        const currentMoved = currentPath
          ? okPaths.has(normMediaPath(currentPath))
          : false
        if (canUndo) {
          setBatchUndoItems((prev) => {
            const map = new Map((prev || []).map((v) => [v.path, v]))
            for (const v of okItems) map.set(v.path, v)
            return Array.from(map.values())
          })
        } else {
          setBatchUndoItems(null)
        }
        const nextList = videos.filter((v) => !okPaths.has(normMediaPath(v.path)))
        setVideos(nextList)
        setBatchResultModal({
          category,
          results,
          canUndo,
          cancelled
        })
        if (currentMoved) {
          dirtyRef.current = false
          const nextIdx = nextList.findIndex((v) => !v.completed)
          if (nextIdx >= 0) await loadVideoAt(nextIdx, nextList)
          else if (nextList.length > 0) await loadVideoAt(0, nextList)
          else {
            setMediaUrl('')
            setIndex(0)
          }
        }
        setStatus('重试完成')
      } catch (err) {
        showToast(String(err))
        setStatus('重试失败')
      }
    },
    [
      busy,
      videos,
      index,
      showToast,
      releaseMediaHandles,
      thumbPreviewIds.size,
      loadVideoAt
    ]
  )
  const undoBatchClassify = useCallback(async () => {
    if (busy || batchUndoItems === null) {
      showToast('没有可撤回的批量分类')
      return
    }
    setStatus('正在撤回批量分类…')
    try {
      const { restored, errors } = await window.api.undoBatchClassify()
      const items = batchUndoItems
      setBatchUndoItems(null)
      if (restored > 0 && items.length > 0) {
        setVideos((prev) => {
          const have = new Set(prev.map((v) => normMediaPath(v.path)))
          const add = items
            .filter((v) => !have.has(normMediaPath(v.path)))
            .map((v) => ({ ...v, completed: false }))
          return [...prev, ...add].sort((a, b) => compareMediaPaths(a.path, b.path))
        })
      } else if (restored > 0 && items.length === 0) {
        showToast(`已撤回 ${restored} 个到原目录，请重新打开文件夹以刷新列表`)
      }
      if (errors.length) {
        showToast(`已撤回 ${restored} 个，部分失败：${errors[0]}`)
      } else if (items.length > 0) {
        showToast(`已撤回 ${restored} 个视频到原目录`)
      }
      setStatus('')
    } catch (err) {
      showToast(String(err))
      setStatus('撤回失败')
    }
  }, [busy, batchUndoItems, showToast])

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (busy) {
      showToast('正在处理中，无法导入')
      return
    }
    // 同步快照 File，避免事件结束后 FileList 失效；再分片 getPathForFile
    const list = e.dataTransfer.files
    const files: File[] = []
    for (let i = 0; i < list.length; i++) {
      const f = list.item(i)
      if (f) files.push(f)
    }
    if (!files.length) {
      showToast('未识别到可导入的文件或文件夹')
      return
    }
    setStatus(`正在导入 ${files.length} 项…`)
    void (async () => {
      const paths: string[] = []
      const chunk = 40
      for (let i = 0; i < files.length; i++) {
        try {
          const p = window.api.getPathForFile(files[i])
          if (p) paths.push(p)
        } catch {
          /* ignore */
        }
        if (i > 0 && i % chunk === 0) {
          setStatus(`正在读取路径…（${i}/${files.length}）`)
          await new Promise<void>((r) => window.setTimeout(r, 0))
        }
      }
      if (!paths.length) {
        showToast('未识别到可导入的文件或文件夹')
        setStatus('')
        return
      }
      setStatus(`正在导入 ${paths.length} 项…`)
      await importPaths(paths)
    })()
  }

  const finishCurrent = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (!current) return true
      const hasExports = clipExports.length > 0
      const operated = hasExports || dirtyRef.current
      // 静默切换/回家：无操作则跳过；显式点「完成」即使无导出也标已完成
      if (!operated && opts?.silent) {
        dirtyRef.current = false
        return true
      }
      // 已完成且无新改动：切视频时不必再写一遍
      if ((current.completed || completedRef.current) && opts?.silent && !dirtyRef.current) {
        return true
      }
      const oldPath = current.path
      const gen = loadGenRef.current
      try {
        // Windows：播放中占用文件句柄会导致 rename 失败；先松开媒体（含缩略图小窗）
        await releaseMediaHandles()

        const result = await window.api.finishVideo({
          sourcePath: oldPath,
          hasExported: hasExports,
          markDone: true
        })
        if (gen !== loadGenRef.current) return true
        const newPath = result?.path || oldPath
        dirtyRef.current = false
        completedRef.current = true
        setUndoCount(0)
        setUiUndoStack([])
        setTimelineMarkers([])
        setVideos((prev) =>
          prev.map((v, i) =>
            i === index
              ? { ...v, completed: true, path: newPath, name: fileNameOf(newPath) }
              : v
          )
        )
        if (newPath !== oldPath) {
          const oldSec = remainingByPathRef.current.get(oldPath)
          remainingByPathRef.current.delete(oldPath)
          if (oldSec !== undefined) remainingByPathRef.current.set(newPath, oldSec)
          setRemainingHints((prev) => {
            if (!(oldPath in prev) && !(newPath in prev)) return prev
            const next = { ...prev }
            if (oldPath in next) {
              next[newPath] = next[oldPath]
              delete next[oldPath]
            }
            return next
          })
        }
        if (hasExports) syncRemainingHint(newPath, 0)
        try {
          await reloadPlayableMedia(newPath)
        } catch {
          /* ignore */
        }
        if (gen !== loadGenRef.current) return true
        const n = clipExports.length
        setStatus(n > 0 ? `已完成 · 已分类 ${n}` : '已完成')
        if (!opts?.silent) {
          showToast(
            n > 0
              ? '已完成：分类已写入片段文件名，重开文件夹可回看'
              : '已标记为完成'
          )
        }
        return true
      } catch (err) {
        reportClientError('finishVideo', err, { path: oldPath })
        showToast(String(err))
        // 失败时尽量恢复预览
        try {
          await reloadPlayableMedia(oldPath)
        } catch {
          /* ignore */
        }
        return false
      }
    },
    [
      current,
      index,
      clipExports.length,
      showToast,
      syncRemainingHint,
      releaseMediaHandles,
      reloadPlayableMedia
    ]
  )

  /**
   * 对已完成视频开始改动时，去掉完成标记。
   * 并发调用会合并为同一次请求，避免拖动手柄连点竞态。
   * @returns 撤销后的路径；失败时返回 null；无需处理时返回当前路径
   */
  const clearCompletedMark = useCallback(async (): Promise<string | null> => {
    if (clearCompletedInflightRef.current) {
      return clearCompletedInflightRef.current
    }
    const run = async (): Promise<string | null> => {
      if (!current) return null
      if (!current.completed && !completedRef.current) return current.path
      const oldPath = current.path
      const gen = loadGenRef.current
      try {
        await releaseMediaHandles()

        const res = await window.api.clearCompleted(oldPath)
        const newPath = res?.path || oldPath
        if (gen !== loadGenRef.current) return newPath

        setVideos((prev) =>
          prev.map((v) =>
            normMediaPath(v.path) === normMediaPath(oldPath)
              ? { ...v, completed: false, path: newPath, name: fileNameOf(newPath) }
              : v
          )
        )
        if (newPath !== oldPath) {
          const oldSec = remainingByPathRef.current.get(oldPath)
          remainingByPathRef.current.delete(oldPath)
          if (oldSec !== undefined) remainingByPathRef.current.set(newPath, oldSec)
          setRemainingHints((prev) => {
            if (!(oldPath in prev)) return prev
            const next = { ...prev }
            next[newPath] = next[oldPath]
            delete next[oldPath]
            return next
          })
        }
        try {
          if (gen === loadGenRef.current) await reloadPlayableMedia(newPath)
        } catch {
          /* ignore */
        }
        completedRef.current = false
        dirtyRef.current = true
        setStatus('重新编辑')
        return newPath
      } catch (err) {
        reportClientError('clearCompleted', err, { path: oldPath })
        try {
          if (gen === loadGenRef.current) await reloadPlayableMedia(oldPath)
        } catch {
          /* ignore */
        }
        return null
      }
    }
    const p = run().finally(() => {
      if (clearCompletedInflightRef.current === p) {
        clearCompletedInflightRef.current = null
      }
    })
    clearCompletedInflightRef.current = p
    return p
  }, [current, releaseMediaHandles, reloadPlayableMedia])

  const dismissWhatsNew = useCallback(() => {
    const modal = whatsNewModal
    setWhatsNewModal(null)
    if (modal?.version) {
      void window.api.markWhatsNewSeen(modal.version).catch((err: unknown) => {
        reportClientError('markWhatsNewSeen', err)
      })
    }
    const pending = pendingRecoverSessionsRef.current
    pendingRecoverSessionsRef.current = null
    if (pending && pending.length > 0) {
      setRecoverModal({ sessions: pending, index: 0 })
    }
  }, [whatsNewModal])

  /** 显式将当前媒体改回未完成 */
  const markCurrentIncomplete = useCallback(async (): Promise<void> => {
    if (!current || busy) return
    if (!current.completed && !completedRef.current) {
      showToast('当前已是未完成')
      return
    }
    const newPath = await clearCompletedMark()
    if (!newPath) {
      showToast('撤销完成标记失败')
      return
    }
    setStatus('已撤销完成标记')
    showToast('已撤销完成标记，可继续编辑')
  }, [current, busy, showToast, clearCompletedMark])

  const goToIndex = useCallback(
    async (nextIndex: number) => {
      if (navigatingRef.current || busy || nextIndex === index) return
      if (nextIndex < 0 || nextIndex >= videos.length) return

      navigatingRef.current = true
      try {
        // 切换前始终保存并标记已完成（有操作时）
        const ok = await finishCurrent({ silent: true })
        if (!ok) return
        await loadVideoAt(nextIndex)
      } finally {
        navigatingRef.current = false
      }
    },
    [busy, index, videos.length, loadVideoAt, finishCurrent]
  )

  const goRelative = useCallback(
    async (dir: -1 | 1) => {
      if (!videos.length) return
      let i = index
      for (let step = 0; step < videos.length; step++) {
        i = (i + dir + videos.length) % videos.length
        // 环绕回到自身时跳过，避免 goToIndex 因 next===index 静默 no-op
        if (i === index) continue
        // 下一个：可按「只看未完成」跳过；上一个：始终可回到刚处理好的视频回看分类
        if (
          dir === 1 &&
          onlyIncomplete &&
          videos[i] &&
          !videoShowsAsIncomplete(videos[i], i, index, remainingByPathRef.current)
        )
          continue
        await goToIndex(i)
        return
      }
      showToast(dir === 1 ? '没有更多未完成视频' : '没有上一个视频')
    },
    [videos, index, onlyIncomplete, goToIndex, showToast]
  )

  finishCurrentRef.current = finishCurrent
  goRelativeRef.current = goRelative

  /** 单击缩略图：单选并切换当前项 */
  const selectOnlyAndOpen = useCallback(
    (id: string, listIndex: number) => {
      selectAnchorRef.current = listIndex
      setSelectedIds(new Set([id]))
      setThumbPreviewIds(new Set())
      void goToIndex(listIndex)
    },
    [goToIndex]
  )

  /** 缩略图播放键：多选且点中已选项 → 同播；否则只播/停这一个 */
  const handleThumbPlay = useCallback(
    (id: string) => {
      const item = videos.find((v) => v.id === id)
      if (!item || item.mediaKind === 'image' || isImagePath(item.path)) return

      setThumbPreviewIds((prev) => {
        const multi = selectedIds.size > 1 && selectedIds.has(id)
        if (multi) {
          const targetIds = videos
            .filter(
              (v) =>
                selectedIds.has(v.id) &&
                v.mediaKind !== 'image' &&
                !isImagePath(v.path)
            )
            .map((v) => v.id)
          if (targetIds.length === 0) return prev
          const allPlaying = targetIds.every((t) => prev.has(t))
          if (allPlaying) return new Set()
          return new Set(targetIds)
        }
        if (prev.has(id) && prev.size === 1) return new Set()
        return new Set([id])
      })
    },
    [videos, selectedIds]
  )

  /** 点击左上角图标：保存并标记所有操作过的视频为已完成，退回主界面 */
  const saveAllAndGoHome = useCallback(async (): Promise<void> => {
    if (busy) {
      showToast('正在处理中，请稍候…')
      return
    }
    if (videos.length === 0) {
      showToast('已在主界面')
      return
    }
    setStatus('正在保存…')
    try {
      const ok = await finishCurrent({ silent: true })
      if (!ok) return
      // 只处理确实有工作区会话的项，避免对整表无会话调用 finish 刷错误日志
      let pending: Awaited<ReturnType<typeof window.api.listPendingSessions>> = []
      try {
        pending = await window.api.listPendingSessions()
      } catch {
        pending = []
      }
      const pendingPaths = new Set(pending.map((s) => normMediaPath(s.sourcePath)))
      const completedRenames: { from: string; to: string }[] = []
      for (const v of videos) {
        if (current && v.path === current.path) {
          if (completedRef.current || v.completed) {
            completedRenames.push({ from: v.path, to: current.path })
          }
          continue
        }
        if (v.completed) continue
        if (!pendingPaths.has(normMediaPath(v.path))) continue
        try {
          const result = await window.api.finishVideo({
            sourcePath: v.path,
            hasExported: true,
            soft: true,
            markDone: true
          })
          completedRenames.push({ from: v.path, to: result?.path || v.path })
        } catch {
          /* soft 仍可能因 busy 等失败，忽略 */
        }
      }
      if (completedRenames.length) {
        const byFrom = new Map(
          completedRenames.map((r) => [normMediaPath(r.from), r.to] as const)
        )
        setVideos((prev) =>
          prev.map((v) => {
            const to = byFrom.get(normMediaPath(v.path))
            return to
              ? { ...v, completed: true, path: to, name: fileNameOf(to) }
              : v
          })
        )
      }
      loadGenRef.current++
      setVideos([])
      setIndex(0)
      setMediaUrl('')
      setExportPreviewUrl(null)
      setSelectedIds(new Set())
      selectAnchorRef.current = null
      setBatchUndoItems(null)
      setClipExports([])
      setRemaining([])
      setSaveModal(null)
      setImportChoiceModal(null)
      setCrop(FULL_CROP)
      setCropActive(false)
      setCropCommitted(false)
      setStatus('')
      dirtyRef.current = false
      completedRef.current = false
      showToast('已保存并返回主界面')
    } catch (err) {
      showToast(String(err))
      setStatus('保存失败')
    }
  }, [busy, videos, current, finishCurrent, showToast])

  const openSaveModal = useCallback(async () => {
    if (!current || busy) return
    if (selectedExportPath) {
      showToast('正在查看已分类结果，请先按 Delete 删除后再裁剪，或取消选中后继续')
      return
    }
    await clearCompletedMark()
    const isImage = current.mediaKind === 'image' || isImagePath(current.path)
    let start = isImage ? 0 : Math.min(selStart, selEnd)
    let end = isImage ? Math.max(duration, IMAGE_TIMELINE_SECONDS) : Math.max(selStart, selEnd)
    if (!isImage) {
      const check = resolveClipSelection(start, end, remaining, clipExports, stepFps)
      if (!check.ok) {
        setConfirmModal({
          title: '无法保存片段',
          message: check.reason,
          confirmText: '知道了',
          onConfirm: () => {}
        })
        return
      }
      start = check.start
      end = check.end
      if (start !== selStart || end !== selEnd) {
        selStartRef.current = start
        selEndRef.current = end
        setSelStart(start)
        setSelEnd(end)
      }
    }
    const initialCat = defaultCategoryFromDir(current.parentDirName)
    setCategoryInput(initialCat)
    setSaveDestRoot(
      sessionCustomSaveRootRef.current?.trim() || defaultSaveRootDir(current.path)
    )
    try {
      videoRef.current?.pause()
    } catch {
      /* ignore */
    }
    setSavePreviewLocal(0)
    setSavePreviewPlaying(false)
    const cropOn = cropActive && cropCommitted && isMeaningfulCrop(crop)
    setSaveModal({
      start,
      end,
      crop: cropOn ? crop : FULL_CROP,
      cropActive: cropOn,
      previewUrl: mediaUrl
    })
  }, [
    current,
    busy,
    selectedExportPath,
    selStart,
    selEnd,
    remaining,
    clipExports,
    crop,
    cropActive,
    cropCommitted,
    mediaUrl,
    duration,
    stepFps,
    showToast,
    clearCompletedMark,
    setConfirmModal
  ])

  /** 保存弹窗预览：必须先落到选区起点再播，不能 autoPlay 从片头开跑 */
  useEffect(() => {
    if (!saveModal || currentIsImage) return
    let cancelled = false
    const start = saveModal.start
    const end = saveModal.end
    let tries = 0

    const seekTo = (v: HTMLVideoElement, t: number): Promise<void> =>
      new Promise((resolve) => {
        const done = (): void => {
          v.removeEventListener('seeked', done)
          window.clearTimeout(failSafe)
          resolve()
        }
        const failSafe = window.setTimeout(done, 500)
        v.addEventListener('seeked', done)
        try {
          v.currentTime = Math.max(0, t)
        } catch {
          done()
        }
      })

    const run = async (v: HTMLVideoElement): Promise<void> => {
      try {
        v.pause()
      } catch {
        /* ignore */
      }
      setSavePreviewLocal(0)
      setSavePreviewPlaying(false)
      const nudge =
        start < 0.12 ? Math.min(start + 0.15, Math.max(0, end - 0.05)) : Math.max(0, start - 0.12)
      await seekTo(v, nudge)
      if (cancelled) return
      await seekTo(v, start)
      if (cancelled) return
      setSavePreviewLocal(0)
      try {
        await v.play()
        if (!cancelled) setSavePreviewPlaying(true)
      } catch {
        /* ignore autoplay policy */
      }
    }

    const startWhenReady = (): void => {
      if (cancelled) return
      const v = savePreviewRef.current
      if (!v) {
        if (tries++ < 30) {
          window.requestAnimationFrame(startWhenReady)
        }
        return
      }
      if (v.readyState >= 1) {
        void run(v)
        return
      }
      const onMeta = (): void => {
        v.removeEventListener('loadedmetadata', onMeta)
        void run(v)
      }
      v.addEventListener('loadedmetadata', onMeta)
    }

    startWhenReady()
    return () => {
      cancelled = true
    }
  }, [saveModal, currentIsImage])

  const confirmSave = async (categoryOverride?: string): Promise<void> => {
    if (!current || !saveModal) return
    if (savingRef.current || busy) {
      showToast('正在保存，请稍候…')
      return
    }
    const category = (categoryOverride ?? categoryInput).trim()
    if (!category) {
      showToast('请选择类别')
      return
    }
    const root = (
      saveDestRoot.trim() ||
      sessionCustomSaveRootRef.current?.trim() ||
      defaultSaveRootDir(current.path)
    ).trim()
    if (!root) {
      showToast('请填写或选择保存路径')
      return
    }
    if (categoryOverride) setCategoryInput(category)
    setSaveDestRoot(root)
    const isImage = current.mediaKind === 'image' || isImagePath(current.path)
    const pending: PendingSaveClip = {
      category,
      isImage,
      saveModal,
      sourcePath: current.path,
      duration
    }
    await runSaveClipExport(pending, {
      reclassifyMode: 'customRoot',
      customDestDir: root
    })
  }
  confirmSaveRef.current = confirmSave

  const pickSaveDestDir = useCallback(async () => {
    if (!current) return
    const defaultPath =
      saveDestRoot.trim() ||
      sessionCustomSaveRootRef.current?.trim() ||
      dialogDefaultPathFor(current, videos) ||
      undefined
    try {
      const dir = await window.api.pickDirectory({
        title: '选择类别文件夹的源目录',
        defaultPath
      })
      if (dir) {
        sessionCustomSaveRootRef.current = dir
        setSaveDestRoot(dir)
      }
    } catch (err) {
      showToast(String(err))
    }
  }, [current, saveDestRoot, videos, showToast])

  const onSaveCategorySelect = useCallback((tag: string) => {
    setCategoryInput(tag)
  }, [])

  const onSaveDestRootChange = useCallback((raw: string) => {
    const cat = categoryInput.trim()
    const san = cat ? sanitizeName(cat) : ''
    let root = raw
    if (san && san !== 'unnamed' && (mediaBasename(raw) === san || mediaBasename(raw) === cat)) {
      root = mediaDirname(raw) || raw
    }
    sessionCustomSaveRootRef.current = root.trim() || null
    setSaveDestRoot(root)
  }, [categoryInput])

  const savePathDisplay = categoryInput.trim()
    ? categoryDirUnderRoot(saveDestRoot, categoryInput)
    : saveDestRoot

  const undo = async (): Promise<void> => {
    if (!current || busy) return
    try {
      const pathAfter = await clearCompletedMark()
      if (!pathAfter) {
        showToast('无法撤销完成标记，请重试')
        return
      }
      const session = await window.api.undoExport(pathAfter)
      applySessionFromMain(session)
      showToast('已撤销上一次保存')
    } catch (err) {
      showToast(String(err))
    }
  }

  const undoAny = useCallback(async () => {
    // 当前视频有剪辑可撤时优先，避免批量撤回盖过正在编辑的撤销
    if (undoCount > 0) {
      await undo()
      return
    }
    if (batchUndoItems !== null) {
      await undoBatchClassify()
      return
    }
    setUiUndoStack((stack) => {
      if (stack.length === 0) {
        showToast('没有可撤回的操作')
        return stack
      }
      const next = [...stack]
      const entry = next.pop()!
      if (entry.kind === 'markers') {
        setTimelineMarkers(entry.markers)
        setStatus(`已恢复标记（${entry.markers.length}）`)
        return next
      }
      setSelStart(entry.selStart)
      setSelEnd(entry.selEnd)
      setFineTuneWhich(entry.fineTuneWhich)
      if (entry.fineTuneWhich) {
        scheduleFilmstrip(
          entry.fineTuneWhich,
          entry.fineTuneWhich === 'in' ? entry.selStart : entry.selEnd
        )
      }
      setStatus('已撤回选区')
      return next
    })
  }, [batchUndoItems, undoBatchClassify, undoCount, showToast, scheduleFilmstrip, current, busy])

  const snapEdgeToNearbyMarker = useCallback(
    (t: number, lo: number, hi: number): { time: number; snapped: boolean } => {
      const markers = timelineMarkersRef.current
      if (markers.length === 0) return { time: t, snapped: false }
      const trackW = Math.max(1, trackRef.current?.getBoundingClientRect().width ?? 1)
      const span = Math.max(0.05, timelineViewRef.current.span)
      // 约 10px 或 1.5 步进格，取较大者
      const threshold = Math.max(frameDuration(stepFpsRef.current) * 1.5, (10 / trackW) * span)
      let best = t
      let bestDist = threshold
      for (const m of markers) {
        if (m.time < lo - 1e-6 || m.time > hi + 1e-6) continue
        const d = Math.abs(m.time - t)
        if (d <= bestDist) {
          bestDist = d
          best = m.time
        }
      }
      if (best === t) return { time: t, snapped: false }
      return { time: clamp(best, lo, hi), snapped: true }
    },
    []
  )

  const clearTimelineMarkers = useCallback(() => {
    const prev = timelineMarkersRef.current
    if (prev.length === 0) {
      showToast('没有标记可清除')
      return
    }
    pushUiUndo({
      kind: 'markers',
      markers: prev.map((m) => ({ ...m })),
      label: `清除 ${prev.length} 个标记`
    })
    setTimelineMarkers([])
    setStatus('已清除标记（可撤回）')
  }, [pushUiUndo, showToast])

  const removeTimelineMarker = useCallback(
    (id: string) => {
      const prev = timelineMarkersRef.current
      const target = prev.find((m) => m.id === id)
      if (!target) return
      pushUiUndo({
        kind: 'markers',
        markers: prev.map((m) => ({ ...m })),
        label: `删除标记 ${formatTimecode(target.time, stepFpsRef.current)}`
      })
      setTimelineMarkers((list) => list.filter((m) => m.id !== id))
      setStatus('已删除标记（可撤回）')
    },
    [pushUiUndo]
  )

  const applySessionFromMain = useCallback((session: SessionState) => {
    const precise = session.exports.filter((e) => !e.approx)
    const isImage = isImagePath(session.sourcePath)
    const dur = session.duration > 0 ? session.duration : IMAGE_TIMELINE_SECONDS
    const rem = isImage
      ? [{ start: 0, end: dur }]
      : session.duration > 0
        ? computeRemainingFromExports(session.duration, precise)
        : session.remainingRanges
    setRemaining(rem)
    syncRemainingHint(session.sourcePath, totalDuration(rem))
    setClipExports(session.exports)
    setSelectedExportPath(null)
    setExportPreviewUrl(null)
    setUndoCount(session.undoStack.length)
    dirtyRef.current = precise.length > 0
    const span = selectionSpanFromRemaining(rem)
    setSelStart(span.start)
    setSelEnd(span.end)
  }, [syncRemainingHint])

  const syncSelectionToRemaining = useCallback(() => {
    if (!current || selectedExportPath) return
    if (document.body.classList.contains('dragging-sel-handle')) return
    const resolved = resolveClipSelection(
      selStartRef.current,
      selEndRef.current,
      remaining,
      clipExports,
      stepFps
    )
    if (!resolved.ok) return
    if (
      Math.abs(resolved.start - selStartRef.current) > 1e-6 ||
      Math.abs(resolved.end - selEndRef.current) > 1e-6
    ) {
      selStartRef.current = resolved.start
      selEndRef.current = resolved.end
      setSelStart(resolved.start)
      setSelEnd(resolved.end)
    }
  }, [current, selectedExportPath, remaining, clipExports, stepFps])

  useEffect(() => {
    syncSelectionToRemaining()
  }, [syncSelectionToRemaining])

  const addTimelineMarker = useCallback(
    (time?: number) => {
      const t = snapToFrame(time ?? currentTime, stepFps)
      setTimelineMarkers((prev) => {
        if (prev.some((m) => Math.abs(m.time - t) < frameDuration(stepFps) * 0.51)) {
          showToast('此处已有标记')
          return prev
        }
        const next = [...prev, { id: `mk-${Date.now()}-${Math.round(t * 1000)}`, time: t }]
        next.sort((a, b) => a.time - b.time)
        return next
      })
      setStatus(`已标记 ${formatTimecode(t, stepFps)}`)
    },
    [currentTime, stepFps, showToast]
  )

  const toggleSelectionPlayback = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      setStillFrameUrl(null)
      const a = Math.min(selStartRef.current, selEndRef.current)
      const b = Math.max(selStartRef.current, selEndRef.current)
      // 空格播放：按当前选区播；区外或已到出点则从入点重播
      if (b - a >= 0.05) {
        if (v.currentTime < a - 0.02 || v.currentTime >= b - 0.05) {
          void playSelection(a, b)
          return
        }
        previewEndRef.current = b
      } else {
        previewEndRef.current = null
      }
      const gen = ++playbackGenRef.current
      v.playbackRate = playbackRate
      void v
        .play()
        .then(() => {
          if (gen !== playbackGenRef.current) {
            try {
              v.pause()
            } catch {
              /* ignore */
            }
          }
        })
        .catch(() => {
          /* ignore */
        })
    } else {
      playbackGenRef.current++
      previewEndRef.current = null
      v.pause()
    }
  }, [playbackRate, playSelection])

  const handleVideoStageClick = useCallback(
    (e: React.MouseEvent) => {
      if (currentIsImage || !mediaUrl) return
      if (e.detail > 1) return
      const target = e.target as HTMLElement
      if (target.closest('.crop-box, .crop-handle, .view-zoom-badge')) return
      if (!cropCommitted && target.closest('.crop-overlay')) return
      if (stageClickSuppressRef.current) {
        stageClickSuppressRef.current = false
        return
      }
      window.clearTimeout(videoStageClickTimerRef.current)
      videoStageClickTimerRef.current = window.setTimeout(() => {
        videoStageClickTimerRef.current = 0
        toggleSelectionPlayback()
      }, 220)
    },
    [currentIsImage, mediaUrl, cropCommitted, toggleSelectionPlayback]
  )

  const deleteSelectedExport = useCallback(async () => {
    if (!current || busy || !selectedExportPath) return
    try {
      const pathAfter = await clearCompletedMark()
      if (!pathAfter) {
        showToast('无法撤销完成标记，请重试')
        return
      }
      const session = await window.api.deleteExport(pathAfter, selectedExportPath)
      applySessionFromMain(session)
      showToast('已删除分类片段，该时段可重新裁剪')
    } catch (err) {
      showToast(String(err))
    }
  }, [current, busy, selectedExportPath, applySessionFromMain, showToast, clearCompletedMark])

  const removeFromWorkspaceItems = useCallback(
    async (targets: VideoItem[]) => {
      if (busy || targets.length === 0) return

      const targetPaths = new Set(targets.map((v) => v.path))
      const currentRemoved = Boolean(current && targetPaths.has(current.path))

      try {
        for (const v of targets) {
          await window.api.removeFromWorkspace(v.path, false)
        }

        const nextList = videos.filter((v) => !targetPaths.has(v.path))
        setVideos(nextList)
        setSelectedIds((prev) => {
          const next = new Set(prev)
          for (const v of targets) next.delete(v.id)
          return next
        })
        selectAnchorRef.current = null
        dirtyRef.current = false

        if (nextList.length === 0) {
          setMediaUrl('')
          setExportPreviewUrl(null)
          setIndex(0)
          setStatus('列表已空')
          showToast('已从工作区移除（原文件保留）')
          return
        }

        if (currentRemoved) {
          const nextIdx = Math.min(index, nextList.length - 1)
          await loadVideoAt(nextIdx, nextList)
        } else {
          const removedBefore = videos.slice(0, index).filter((v) => targetPaths.has(v.path)).length
          if (removedBefore > 0) setIndex((i) => i - removedBefore)
        }

        showToast(`已从工作区移除 ${targets.length} 项（原文件保留）`)
      } catch (err) {
        showToast(String(err))
      }
    },
    [busy, current, videos, index, loadVideoAt, showToast]
  )

  const removeSelectedFromWorkspace = useCallback(() => {
    if (busy) return
    const targets =
      selectedIds.size > 0
        ? videos.filter((v) => selectedIds.has(v.id))
        : current
          ? [current]
          : []
    if (targets.length === 0) return
    void removeFromWorkspaceItems(targets)
  }, [busy, selectedIds, videos, current, removeFromWorkspaceItems])

  const requestDeleteCategoryTag = useCallback(
    (tag: string) => {
      const name = tag.trim()
      if (!name) return
      if (isBuiltinCategoryTag(name)) {
        showToast('预设标签不可删除')
        return
      }
      if (!findCustomCategoryGroup(name)) {
        showToast('只能删除手动添加的标签')
        return
      }
      if (deleteCategoryTagSkipAskRef.current) {
        const result = tryRemoveCustomCategoryTag(name)
        if (!result.ok) {
          showToast(result.error)
          return
        }
        saveCustomCategoryTags()
        void window.api.setCustomCategories(getCustomCategoryTags())
        setCategoryTagsRevision((n) => n + 1)
        if (categoryInput.trim() === name) setCategoryInput('')
        if (batchCategory.trim() === name) setBatchCategory('')
        showToast(`已删除标签「${name}」`)
        return
      }
      setDeleteCategoryTagDontAsk(false)
      setDeleteCategoryTagModal({ tag: name })
    },
    [showToast, categoryInput, batchCategory]
  )

  const confirmDeleteCategoryTag = useCallback(() => {
    const modal = deleteCategoryTagModal
    if (!modal) return
    const name = modal.tag
    if (deleteCategoryTagDontAsk) {
      deleteCategoryTagSkipAskRef.current = true
    }
    setDeleteCategoryTagModal(null)
    const result = tryRemoveCustomCategoryTag(name)
    if (!result.ok) {
      showToast(result.error)
      return
    }
    saveCustomCategoryTags()
    void window.api.setCustomCategories(getCustomCategoryTags())
    setCategoryTagsRevision((n) => n + 1)
    if (categoryInput.trim() === name) setCategoryInput('')
    if (batchCategory.trim() === name) setBatchCategory('')
    showToast(`已删除标签「${name}」`)
  }, [deleteCategoryTagModal, deleteCategoryTagDontAsk, showToast, categoryInput, batchCategory])

  const selectExportClip = useCallback(
    (exp: ExportRecord) => {
      setSelectedExportPath(exp.path)
      setSelStart(exp.start)
      setSelEnd(exp.end)
      refocusTimelineToSelection(exp.start, exp.end)
      setCrop(FULL_CROP)
      setCropActive(false)
      setCropCommitted(false)
      setStatus(`查看分类：${exp.category}（Delete 删除）`)
      const run = async (): Promise<void> => {
        const gen = ++playbackGenRef.current
        previewEndRef.current = null
        filmstripGenRef.current++
        try {
          const clipUrl = await window.api.getMediaUrl(exp.path)
          if (gen !== playbackGenRef.current) return
          // 优先播已导出片段（H.264），避免片源 HEVC 在 Chromium 里 seek 失败
          setExportPreviewUrl(clipUrl)
        } catch {
          if (gen !== playbackGenRef.current) return
          setExportPreviewUrl(null)
          await playSelection(exp.start, exp.end)
        }
      }
      void run()
    },
    [playSelection, refocusTimelineToSelection]
  )

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName

      // Esc：保存页优先关闭（输入框聚焦时也生效）
      if (e.key === 'Escape') {
        e.preventDefault()
        if (saveModalOpenRef.current) {
          setSaveModal(null)
          return
        }
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        if (modalOpenRef.current) return
        exitAllEditing()
        return
      }

      // 保存弹窗打开时：Enter 确认保存（输入框自己也会处理；此处兜底预览区等焦点）
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && saveModalOpenRef.current) {
        // 标签「+」输入框内 Enter 只提交新标签，不触发保存
        if (
          (tag === 'INPUT' || tag === 'TEXTAREA') &&
          (e.target as HTMLElement)?.classList?.contains('category-chip-add-input')
        ) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        void confirmSaveRef.current()
        return
      }

      // 保存/批量弹窗：Delete 删除当前选中的自定义分类标签
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        (saveModalOpenRef.current || batchModal) &&
        !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')
      ) {
        const tagName = (saveModalOpenRef.current ? categoryInput : batchCategory).trim()
        if (tagName) {
          e.preventDefault()
          e.stopPropagation()
          requestDeleteCategoryTag(tagName)
          return
        }
      }

      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      // 任意弹窗打开时，不响应导航/剪辑快捷键（避免误切视频、误保存）
      if (modalOpenRef.current) return

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedExportPath) {
        e.preventDefault()
        void deleteSelectedExport()
        return
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && videos.length > 0) {
        const hasTarget = selectedIds.size > 0 || current
        if (hasTarget) {
          e.preventDefault()
          removeSelectedFromWorkspace()
          return
        }
      }

      // Enter：打开保存片段（微调时先退出微调）
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        // 刚确认保存后的同一次回车 / 按住重复，禁止立刻再打开
        if (e.repeat || performance.now() < ignoreEnterOpenUntilRef.current) return
        e.preventDefault()
        if (fineTuneWhich) exitFineTune()
        void openSaveModal()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void undoAny()
        return
      }

      // 图片模式：无播放/时间轴相关快捷键，仅保留导航、保存、删除、撤回
      if (currentIsImage) {
        if (e.key === 'ArrowLeft' && !e.shiftKey && !e.altKey) {
          e.preventDefault()
          void goRelative(-1)
        } else if (e.key === 'ArrowRight' && !e.shiftKey && !e.altKey) {
          e.preventDefault()
          void goRelative(1)
        }
        return
      }

      if (fineTuneWhich && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        const dir = e.key === 'ArrowLeft' ? -1 : 1
        nudgeFineTune(dir)
        return
      }

      // M：在播放头打标记（Alt+M 清除全部）
      if (e.key.toLowerCase() === 'm' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        if (e.altKey) {
          clearTimelineMarkers()
          return
        }
        addTimelineMarker(currentTime)
        return
      }
      if (e.key === ' ') {
        e.preventDefault()
        toggleSelectionPlayback()
        return
      }
      if (fineTuneWhich) return

      if (e.key === 'ArrowLeft' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        void goRelative(-1)
        return
      }
      if (e.key === 'ArrowRight' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        void goRelative(1)
        return
      }
      if (selectedExportPath) return

      if (e.key === 'ArrowLeft' && e.shiftKey) {
        e.preventDefault()
        applyFineTuneEdge(
          'in',
          stepByFrames(selStartRef.current, stepFps, -1)
        )
        return
      }
      if (e.key === 'ArrowRight' && e.shiftKey) {
        e.preventDefault()
        applyFineTuneEdge(
          'out',
          stepByFrames(selEndRef.current, stepFps, 1)
        )
        return
      }
      if (e.key === 'ArrowLeft' && e.altKey) {
        e.preventDefault()
        const v = videoRef.current
        if (!v) return
        const next = clamp(stepByFrames(v.currentTime, fps, -1), 0, duration)
        previewEndRef.current = null
        v.pause()
        v.currentTime = next
        setCurrentTime(next)
        return
      }
      if (e.key === 'ArrowRight' && e.altKey) {
        e.preventDefault()
        const v = videoRef.current
        if (!v) return
        const next = clamp(stepByFrames(v.currentTime, fps, 1), 0, duration)
        previewEndRef.current = null
        v.pause()
        v.currentTime = next
        setCurrentTime(next)
        return
      }
      if (e.key === '[') {
        e.preventDefault()
        applyFineTuneEdge('in', snapToFrame(currentTime, stepFps), { toastOnFail: true })
        return
      }
      if (e.key === ']') {
        e.preventDefault()
        applyFineTuneEdge('out', snapToFrame(currentTime, stepFps), { toastOnFail: true })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    selectedExportPath,
    fineTuneWhich,
    fps,
    duration,
    currentTime,
    stepFps,
    deleteSelectedExport,
    removeSelectedFromWorkspace,
    requestDeleteCategoryTag,
    categoryInput,
    batchCategory,
    batchModal,
    videos.length,
    selectedIds.size,
    current,
    exitAllEditing,
    exitFineTune,
    openSaveModal,
    nudgeFineTune,
    undoAny,
    goRelative,
    applyFineTuneEdge,
    addTimelineMarker,
    clearTimelineMarkers,
    toggleSelectionPlayback,
    currentIsImage
  ])

  // timeline interaction
  const timeFromEvent = (e: React.MouseEvent | MouseEvent): number => {
    const el = trackRef.current
    if (!el || duration <= 0) return 0
    const rect = el.getBoundingClientRect()
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    const t = timelineView.start + ratio * timelineView.span
    return snapToFrame(t, fineTuneWhich ? stepFps : fps)
  }

  const findRemainingAt = (t: number): TimeRange | null =>
    remaining.find((r) => t >= r.start - 0.02 && t <= r.end + 0.02) ?? null

  const findExportAt = (t: number): ExportRecord | null =>
    clipExports.find((e) => t >= e.start - 0.02 && t <= e.end + 0.02) ?? null

  const selectionHitsExport = (start: number, end: number): ExportRecord | null =>
    exportBlockingSelection(start, end, clipExports)

  const onTrackPointer = (e: React.MouseEvent): void => {
    // 左键点轨道：移动白色播放头；入/出点仅通过拖拽两端手柄调整
    if (e.button !== 0) return
    if (!mediaUrl || !(duration > 0)) return
    const t = timeFromEvent(e)
    const hitExp = findExportAt(t)
    if (hitExp) {
      exitFineTune()
      selectExportClip(hitExp)
      return
    }
    // 点未分类区域：退出分类预览，恢复入出点手柄以便继续裁剪
    if (selectedExportPath || exportPreviewUrl) {
      setSelectedExportPath(null)
      setExportPreviewUrl(null)
      playbackGenRef.current++
      previewEndRef.current = null
    }
    exitFineTune()
    // 点在选区手柄上时由手柄自己处理（stopPropagation）；此处拖播放头
    startPlayheadDrag(e)
  }

  const startDragHandle = (which: 'in' | 'out') => (e: React.MouseEvent) => {
    if (selectedExportPath) {
      e.stopPropagation()
      e.preventDefault()
      showToast('已分类片段不可裁剪，请先按 Delete 删除，或点击未分类区域退出预览')
      return
    }
    e.stopPropagation()
    e.preventDefault()
    void clearCompletedMark()
    document.body.classList.add('dragging-sel-handle')
    setFineTuneWhich(which)
    // 选段过程中即显示入/出点附近帧
    setStillFrameUrl(null)
    // 若上次播放选区卸过 scrub，拖动前先恢复，否则帧条无法抓帧
    const scrub = scrubVideoRef.current
    if (scrub && mediaUrl) {
      try {
        scrub.src = mediaUrl
      } catch {
        /* ignore */
      }
    }
    const startEdge = which === 'in' ? Math.min(selStart, selEnd) : Math.max(selStart, selEnd)
    if (which === 'out') {
      try {
        videoRef.current?.pause()
      } catch {
        /* ignore */
      }
    }
    scheduleFilmstrip(which, startEdge)

    let liveStart = Math.min(selStart, selEnd)
    let liveEnd = Math.max(selStart, selEnd)
    const undoStart = liveStart
    const undoEnd = liveEnd
    setEdgeDragTime(startEdge)

    let pendingSeek: number | null = null
    let seekRaf = 0
    let lastFilmstripAt = 0
    let lastPointerTime = startEdge
    let lastFailReason: string | null = null
    let lastPreviewAt = 0
    let lastDragToastReason: string | null = null
    let lastDragToastAt = 0
    const notifyEdgeDragBlocked = (reason: string): void => {
      lastFailReason = reason
      const now = performance.now()
      if (reason === lastDragToastReason && now - lastDragToastAt < 1600) return
      lastDragToastReason = reason
      lastDragToastAt = now
      showToast(reason)
    }
    const flushSeek = (): void => {
      seekRaf = 0
      if (pendingSeek == null) return
      const t = pendingSeek
      pendingSeek = null
      const now = performance.now()
      if (now - lastFilmstripAt >= 90) {
        lastFilmstripAt = now
        scheduleFilmstrip(which, t)
      }
      if (which === 'in' && now - lastPreviewAt >= 100) {
        lastPreviewAt = now
        void seekPreviewFrame(t, { force: true })
      }
    }

    const timeFromPointer = (clientX: number): number => {
      const el = trackRef.current
      const view = timelineViewRef.current
      if (!el) return which === 'in' ? liveStart : liveEnd
      const rect = el.getBoundingClientRect()
      const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1)
      return view.start + ratio * view.span
    }

    const move = (ev: MouseEvent): void => {
      const t = timeFromPointer(ev.clientX)
      lastPointerTime = t
      const moved = tryMoveSelectionEdge(
        which,
        t,
        liveStart,
        liveEnd,
        remaining,
        stepFps,
        clipExports
      )
      if (!moved.ok) {
        notifyEdgeDragBlocked(moved.reason)
        return
      }
      lastFailReason = null
      liveStart = moved.start
      liveEnd = moved.end
      setSelStart(liveStart)
      setSelEnd(liveEnd)
      ensureTimelineFocusCovers(liveStart, liveEnd)
      setEdgeDragTime(which === 'in' ? liveStart : liveEnd)
      pendingSeek = which === 'in' ? liveStart : liveEnd
      if (!seekRaf) seekRaf = requestAnimationFrame(flushSeek)
    }

    const up = (): void => {
      document.body.classList.remove('dragging-sel-handle')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (seekRaf) cancelAnimationFrame(seekRaf)
      pendingSeek = null
      setEdgeDragTime(null)

      const fpsStep = stepFpsRef.current
      liveStart = snapToFrame(liveStart, fpsStep)
      liveEnd = snapToFrame(liveEnd, fpsStep)
      const host =
        remaining.find((r) => liveStart >= r.start - 0.05 && liveEnd <= r.end + 0.05) ||
        findRemainingAt((liveStart + liveEnd) / 2)
      const lo = host?.start ?? 0
      const hi = host?.end ?? duration
      const minGap = minSelectionGap(hi - lo)
      if (which === 'in') {
        const hit = snapEdgeToNearbyMarker(liveStart, lo, liveEnd - minGap)
        liveStart = hit.time
      } else {
        const hit = snapEdgeToNearbyMarker(liveEnd, liveStart + minGap, hi)
        liveEnd = hit.time
      }
      if (liveEnd - liveStart < minGap) {
        if (which === 'in') liveStart = clamp(liveEnd - minGap, lo, liveEnd)
        else liveEnd = clamp(liveStart + minGap, liveStart, hi)
        liveStart = snapToFrame(liveStart, fpsStep)
        liveEnd = snapToFrame(liveEnd, fpsStep)
      }

      const finalCheck = validateSelectionRange(
        liveStart,
        liveEnd,
        remaining,
        clipExports,
        fpsStep
      )
      const pointerMoved =
        Math.abs(lastPointerTime - startEdge) > frameDuration(fpsStep) * 0.25

      if (!finalCheck.ok) {
        if (!pointerMoved) {
          if (lastFailReason) showToast(lastFailReason)
          selStartRef.current = undoStart
          selEndRef.current = undoEnd
          setSelStart(undoStart)
          setSelEnd(undoEnd)
          setFineTuneWhich(which)
          return
        }
        liveStart = undoStart
        liveEnd = undoEnd
        selStartRef.current = undoStart
        selEndRef.current = undoEnd
        setSelStart(undoStart)
        setSelEnd(undoEnd)
        setConfirmModal({
          title: which === 'in' ? '无法调整入点' : '无法调整出点',
          message: lastFailReason || finalCheck.reason,
          confirmText: '知道了',
          onConfirm: () => {}
        })
        return
      }

      liveStart = finalCheck.start
      liveEnd = finalCheck.end

      selStartRef.current = liveStart
      selEndRef.current = liveEnd
      setSelStart(liveStart)
      setSelEnd(liveEnd)
      pushUiUndo({
        kind: 'selection',
        selStart: undoStart,
        selEnd: undoEnd,
        fineTuneWhich: null
      })
      refocusTimelineToSelection(liveStart, liveEnd)
      setFineTuneWhich(which)
      const afterPlayToken = ++filmstripAfterPlayTokenRef.current
      if (which === 'in') {
        void playSelection(liveStart, liveEnd).finally(() => {
          if (afterPlayToken !== filmstripAfterPlayTokenRef.current) return
          ensureScrubReady()
          scheduleFilmstrip('in', liveStart)
        })
      } else {
        try {
          videoRef.current?.pause()
        } catch {
          /* ignore */
        }
        ensureScrubReady()
        scheduleFilmstrip('out', liveEnd)
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // crop box drag/resize relative to 实际画面（object-fit: contain）
  const getVideoContentLayout = useCallback((): {
    left: number
    top: number
    width: number
    height: number
  } | null => {
    const mediaEl = currentIsImage ? imageRef.current : videoRef.current
    const frame = mediaEl?.parentElement
    if (!mediaEl || !frame) return null
    const fw = frame.clientWidth || frameSize.w
    const fh = frame.clientHeight || frameSize.h
    const mw =
      (!currentIsImage && (mediaEl as HTMLVideoElement).videoWidth) ||
      videoNatural.w ||
      16
    const mh =
      (!currentIsImage && (mediaEl as HTMLVideoElement).videoHeight) ||
      videoNatural.h ||
      9
    const box = containContentRect(fw, fh, mw, mh)
    if (!(box.width > 1) || !(box.height > 1)) return null
    return box
  }, [currentIsImage, frameSize.w, frameSize.h, videoNatural.w, videoNatural.h])

  const getVideoContentScreenRect = useCallback((): DOMRect | null => {
    const mediaEl = currentIsImage ? imageRef.current : videoRef.current
    const frame = mediaEl?.parentElement
    const layout = getVideoContentLayout()
    if (!mediaEl || !frame || !layout) return null
    const fr = frame.getBoundingClientRect()
    const scaleX = fr.width / Math.max(1, frame.clientWidth)
    const scaleY = fr.height / Math.max(1, frame.clientHeight)
    return new DOMRect(
      fr.left + layout.left * scaleX,
      fr.top + layout.top * scaleY,
      layout.width * scaleX,
      layout.height * scaleY
    )
  }, [getVideoContentLayout, currentIsImage])

  useEffect(() => {
    const frame =
      (currentIsImage ? imageRef.current : videoRef.current)?.parentElement ?? null
    if (!frame) return
    const sync = (): void => {
      setFrameSize({ w: frame.clientWidth, h: frame.clientHeight })
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(frame)
    return () => ro.disconnect()
  }, [mediaUrl, currentIsImage, exportPreviewUrl])

  const cropContentLayout = getVideoContentLayout()

  /** 进入裁切后：在画面上按下拖拽画出裁切框（无预设框） */
  const startCropDraw = (e: React.MouseEvent): void => {
    if (!cropActive || cropCommitted) return
    e.preventDefault()
    e.stopPropagation()
    const box = getVideoContentScreenRect()
    if (!box || !(box.width > 1) || !(box.height > 1)) return
    const ox = clamp((e.clientX - box.left) / box.width, 0, 1)
    const oy = clamp((e.clientY - box.top) / box.height, 0, 1)
    setCrop({ x: ox, y: oy, width: 0, height: 0 })

    const move = (ev: MouseEvent): void => {
      const cx = clamp((ev.clientX - box.left) / box.width, 0, 1)
      const cy = clamp((ev.clientY - box.top) / box.height, 0, 1)
      const x = Math.min(ox, cx)
      const y = Math.min(oy, cy)
      setCrop({
        x,
        y,
        width: Math.abs(cx - ox),
        height: Math.abs(cy - oy)
      })
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const c = cropRef.current
      if (c.width < 0.02 || c.height < 0.02) {
        setCrop(FULL_CROP)
        setCropCommitted(false)
        showToast('裁切区域过小，请重新按住拖拽')
        return
      }
      setCropCommitted(true)
      setStatus('可拖动裁切框或四角微调；再点「取消裁切」可重画')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const startCropDrag = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!cropCommitted) return
    const box = getVideoContentScreenRect()
    if (!box || !(box.width > 1) || !(box.height > 1)) return
    const startX = e.clientX
    const startY = e.clientY
    const origin = { ...crop }

    const move = (ev: MouseEvent): void => {
      const dx = (ev.clientX - startX) / box.width
      const dy = (ev.clientY - startY) / box.height
      let next = { ...origin }
      if (mode === 'move') {
        next.x = clamp(origin.x + dx, 0, 1 - origin.width)
        next.y = clamp(origin.y + dy, 0, 1 - origin.height)
      } else {
        if (mode.includes('w')) {
          const nx = clamp(origin.x + dx, 0, origin.x + origin.width - 0.05)
          next.width = origin.width + (origin.x - nx)
          next.x = nx
        }
        if (mode.includes('e')) {
          next.width = clamp(origin.width + dx, 0.05, 1 - origin.x)
        }
        if (mode.includes('n')) {
          const ny = clamp(origin.y + dy, 0, origin.y + origin.height - 0.05)
          next.height = origin.height + (origin.y - ny)
          next.y = ny
        }
        if (mode.includes('s')) {
          next.height = clamp(origin.height + dy, 0.05, 1 - origin.y)
        }
      }
      setCrop(next)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const beginCropMode = useCallback((): void => {
    if (selectedExportPath) {
      showToast('已分类结果不可画面裁切，请先删除分类结果，或点击未分类区域退出预览')
      return
    }
    void (async () => {
      await clearCompletedMark()
      playbackGenRef.current++
      previewEndRef.current = null
      selectionLoopGuardRef.current = false
      try {
        videoRef.current?.pause()
      } catch {
        /* ignore */
      }
      setStillFrameUrl(null)
      setCrop(FULL_CROP)
      setCropCommitted(false)
      setCropActive(true)
      setStatus('在画面上按住并拖拽，框选裁切区域')
    })()
  }, [selectedExportPath, showToast, clearCompletedMark])

  const cancelCropMode = useCallback((): void => {
    setCrop(FULL_CROP)
    setCropActive(false)
    setCropCommitted(false)
    setStatus('')
  }, [])

  const selLen = Math.abs(selEnd - selStart)
  const selectionMeta = useMemo(() => {
    const a = snapToFrame(Math.min(selStart, selEnd), stepFps)
    const b = snapToFrame(Math.max(selStart, selEnd), stepFps)
    const len = Math.max(0, b - a)
    const lenText = len.toFixed(1)
    return { lenText, a, b }
  }, [selStart, selEnd, stepFps])
  const canSave = currentIsImage
    ? !busy && !!current && !selectedExportPath
    : selLen >= MIN_SELECTION_SECONDS && !busy && !!current && !selectedExportPath

  const recoverCurrent = recoverModal?.sessions[recoverModal.index]

  return (
    <div
      className={`app${dragOver ? ' dragover' : ''}`}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        const related = e.relatedTarget as Node | null
        if (related && e.currentTarget.contains(related)) return
        setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {busy && (
        <div className="busy-banner app-banner">
          <span>{busyProgress || '正在处理，请勿切换或关闭…'}</span>
          <button
            type="button"
            className="busy-cancel-btn"
            onClick={() => {
              void window.api.cancelBusyWork().then((r) => {
                if (r.ok) {
                  showToast(
                    `已请求取消。导出会尽快中止；批量移动：已完成项可用 ${MOD_KEY}+Z 撤回`
                  )
                } else showToast(r.message || '无法取消')
              })
            }}
          >
            取消
          </button>
        </div>
      )}
      {updateBanner && (
        <div className="busy-banner app-banner busy-banner-accent">
          {updateBanner}{' '}
          <button
            className="primary"
            style={{ marginLeft: 8 }}
            onClick={() => {
              if (updateBanner.includes('已下载')) {
                try {
                  window.api.installUpdate()
                } catch (err) {
                  showToast(err instanceof Error ? err.message : '安装更新失败')
                }
                return
              }
              setUpdateBanner((prev) => (prev ? `${prev.replace(/（下载中…）$/, '')}（下载中…）` : prev))
              void window.api
                .downloadUpdate()
                .then(() => showToast('开始下载更新'))
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err)
                  setUpdateBanner((prev) => (prev || '发现新版本').replace(/（下载中…）$/, ''))
                  if (/ZIP file not provided|zip/i.test(msg)) {
                    showToast('该版本缺少 macOS 自动更新包，请到 GitHub Releases 手动下载安装')
                  } else {
                    showToast(msg ? `下载更新失败：${msg}` : '下载更新失败')
                  }
                })
            }}
          >
            {updateBanner.includes('已下载') ? '重启安装' : '下载更新'}
          </button>
        </div>
      )}

      <header className="app-header">
        <div
          className="app-brand"
          role="button"
          tabIndex={0}
          title="保存全部并返回主界面"
          onClick={() => void saveAllAndGoHome()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              void saveAllAndGoHome()
            }
          }}
        >
          <img className="app-brand-icon" src={appIcon} alt="返回主界面" width={36} height={36} />
          <div className="app-brand-text">
            <h1>LabelU Video</h1>
            <p>视频 / 图片剪辑、分类工作台</p>
          </div>
        </div>
        <div className="app-header-actions">
          <button className="primary" disabled={busy} onClick={() => void openViaDialog()}>
            选择文件夹或文件
          </button>
          <button
            disabled={busy || selectedIds.size === 0}
            onClick={() => void openBatchModal()}
          >
            批量分类{selectedIds.size ? ` (${selectedIds.size})` : ''}
          </button>
          <button
            disabled={busy || batchUndoItems === null}
            onClick={() => void undoBatchClassify()}
            title={`将最近一次批量分类的视频移回原目录（仅当次有效，${MOD_KEY}+Z 也可）`}
          >
            撤回批量
          </button>
          <button
            disabled={busy || selectedIds.size === 0}
            onClick={() => {
              setSelectedIds(new Set())
              selectAnchorRef.current = null
              setThumbPreviewIds(new Set())
            }}
          >
            清除选择
          </button>
          <button
            type="button"
            disabled={busy}
            title={appVersion ? `打开异常日志（v${appVersion}）` : '打开异常日志'}
            onClick={() => {
              void (async () => {
                try {
                  const r = await window.api.openExceptionLog()
                  if (!r?.ok && r?.error) showToast(`无法打开日志：${r.error}`)
                } catch (err) {
                  reportClientError('openExceptionLog', err)
                  showToast(String(err))
                }
              })()
            }}
          >
            查看日志
          </button>
          <label className="checkbox-row toolbar-check">
            <input
              type="checkbox"
              checked={onlyIncomplete}
              onChange={(e) => setOnlyIncomplete(e.target.checked)}
            />
            只看未完成
          </label>
          {!current && status ? <span className="header-status">{status}</span> : null}
        </div>
      </header>

      <div
        ref={appBodyRef}
        className={`app-body${sidebarCollapsed ? ' sidebar-collapsed' : ''}${
          mainCollapsed ? ' main-collapsed' : ''
        }`}
      >
      <aside className="sidebar" aria-hidden={sidebarCollapsed}>
        <div className="sidebar-section-title">
          <span>媒体列表</span>
          {listHasBothKinds && (
            <select
              className="media-kind-filter"
              value={mediaKindFilter}
              aria-label="筛选图片或视频"
              onChange={(e) => {
                const next = e.target.value as MediaKindFilter
                setMediaKindFilter(next)
                setSelectedIds(new Set())
                selectAnchorRef.current = null
                // 切到筛选后首个可见项
                window.setTimeout(() => {
                  const indices = videos
                    .map((v, i) => ({ v, i }))
                    .filter(({ v, i }) => {
                      if (
                        onlyIncomplete &&
                        !videoShowsAsIncomplete(v, i, index, remainingHints)
                      )
                        return false
                      if (next === 'image' && !itemIsImage(v)) return false
                      if (next === 'video' && itemIsImage(v)) return false
                      return true
                    })
                    .map(({ i }) => i)
                  if (indices.length === 0) {
                    showToast(next === 'image' ? '没有图片' : next === 'video' ? '没有视频' : '列表为空')
                    return
                  }
                  if (!indices.includes(index)) {
                    void goToIndex(indices[0])
                  }
                }, 0)
              }}
            >
              <option value="all">全部</option>
              <option value="video">仅视频</option>
              <option value="image">仅图片</option>
            </select>
          )}
        </div>
        <div className="thumb-zoom-bar">
          <span>缩略图</span>
          <input
            type="range"
            min={THUMB_SIZE_MIN}
            max={THUMB_SIZE_MAX}
            value={thumbSize}
            onChange={(e) => setThumbSize(Number(e.target.value))}
            aria-label="缩略图大小"
          />
          <span className="thumb-zoom-hint">
            {thumbSize}px · {MOD_KEY}+滚轮
          </span>
        </div>
        <div
          ref={thumbGridRef}
          className="video-list thumb-grid"
          style={{ '--thumb-size': `${thumbSize}px` } as React.CSSProperties}
        >
          {videos.length === 0 ? (
            <div className="empty-list">尚未导入视频或图片</div>
          ) : visibleIndices.length === 0 ? (
            <div className="empty-list">
              {mediaKindFilter === 'image'
                ? '当前筛选下没有图片'
                : mediaKindFilter === 'video'
                  ? '当前筛选下没有视频'
                  : '没有符合条件的媒体'}
            </div>
          ) : (
            <div className="thumb-virtual" style={{ height: thumbVirtual.totalH }}>
              <div
                className="thumb-virtual-window"
                style={{
                  transform: `translateY(${Math.floor(thumbVirtual.start / thumbVirtual.cols) * thumbVirtual.itemH}px)`
                }}
              >
                {thumbVirtual.slice.map(({ videoIndex }) => {
                  const v = videos[videoIndex]
                  if (!v) return null
                  return (
                    <VideoThumb
                      key={v.id}
                      path={v.path}
                      name={v.name}
                      parentDirName={v.parentDirName}
                      completed={v.completed}
                      isCategoryCopy={v.isCategoryCopy}
                      mediaKind={v.mediaKind}
                      active={videoIndex === index}
                      selected={selectedIds.has(v.id)}
                      previewActive={thumbPreviewIds.has(v.id)}
                      disabled={busy}
                      onOpen={() => selectOnlyAndOpen(v.id, videoIndex)}
                      onToggleSelect={() => toggleSelect(v.id, videoIndex)}
                      onRangeSelect={() => rangeSelect(videoIndex)}
                      onPlayClick={() => handleThumbPlay(v.id)}
                    />
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </aside>

      <div
        className="pane-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整左右分栏，拖到边缘可隐藏一侧"
        title="拖拽调整 · 最左隐藏列表 · 最右隐藏播放区 · 双击还原"
        onMouseDown={startSidebarResize}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
      />

      <main className="main" aria-hidden={mainCollapsed}>
        {!current ? (
          <div className={`dropzone ${dragOver ? 'dragover' : ''}`}>
            <img className="dropzone-logo" src={appIcon} alt="" width={96} height={96} />
            <h2 className="dropzone-title">LabelU</h2>
            <p className="dropzone-desc">拖入文件夹、视频或图片，或点下方选择</p>
            <button className="primary dropzone-cta" disabled={busy} onClick={() => void openViaDialog()}>
              选择文件夹或文件
            </button>
          </div>
        ) : (
          <>
            <div className="category-banner">
              {isPresetCategory(current.parentDirName) && (
                <div>
                  <div className="label">类别（上级目录）</div>
                  <div className="value">{current.parentDirName}</div>
                </div>
              )}
            </div>

            <div
              className={`player-wrap${currentIsImage ? ' is-image-mode' : ''}`}
              ref={playerWrapRef}
            >
              <div
                className={`video-stage ${viewZoom > 1.001 ? 'zoomed' : ''}`}
                ref={stageRef}
                onClick={handleVideoStageClick}
                onDoubleClick={(e) => {
                  window.clearTimeout(videoStageClickTimerRef.current)
                  videoStageClickTimerRef.current = 0
                  if ((e.target as HTMLElement).closest('.crop-box')) return
                  resetViewZoom()
                }}
                onMouseDown={(e) => {
                  if (viewZoom <= 1.001 || e.button !== 0) return
                  if ((e.target as HTMLElement).closest('.crop-box, .crop-handle')) {
                    return
                  }
                  e.preventDefault()
                  stageClickSuppressRef.current = false
                  const startX = e.clientX
                  const startY = e.clientY
                  const origin = { ...viewPanRef.current }
                  let moved = false
                  const move = (ev: MouseEvent): void => {
                    const dx = ev.clientX - startX
                    const dy = ev.clientY - startY
                    if (!moved && dx * dx + dy * dy < 9) return
                    moved = true
                    stageClickSuppressRef.current = true
                    setViewPan(
                      clampViewPan(viewZoomRef.current, {
                        x: origin.x + dx,
                        y: origin.y + dy
                      })
                    )
                  }
                  const up = (): void => {
                    window.removeEventListener('mousemove', move)
                    window.removeEventListener('mouseup', up)
                    document.body.classList.remove('panning-video')
                  }
                  document.body.classList.add('panning-video')
                  window.addEventListener('mousemove', move)
                  window.addEventListener('mouseup', up)
                }}
              >
                <div
                  className={`video-zoom-layer ${viewZoom > 1.001 ? 'is-zoomed' : ''}`}
                  style={
                    viewZoom > 1.001
                      ? {
                          transform: `translate(${viewPan.x}px, ${viewPan.y}px) scale(${viewZoom})`
                        }
                      : undefined
                  }
                >
                  <div className="video-frame">
                    {currentIsImage ? (
                      exportPreviewUrl || mediaUrl ? (
                      <img
                        ref={imageRef}
                        key={exportPreviewUrl || mediaUrl}
                        className="video-main-image"
                        src={exportPreviewUrl || mediaUrl}
                        alt=""
                        draggable={false}
                        onLoad={(e) => {
                          const img = e.currentTarget
                          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                            setVideoNatural({ w: img.naturalWidth, h: img.naturalHeight })
                          }
                          const frame = img.parentElement
                          if (frame) {
                            setFrameSize({ w: frame.clientWidth, h: frame.clientHeight })
                          }
                        }}
                        onError={(e) => {
                          // 切换媒体 / 清空 src 时浏览器也会触发 error，忽略陈旧回调
                          const src = e.currentTarget.currentSrc || e.currentTarget.src
                          if (!src) return
                          const active = exportPreviewUrlRef.current || mediaUrlRef.current
                          if (!active || src !== active) return
                          showToast('图片无法显示（文件损坏或格式不受支持）')
                          setStatus('图片加载失败')
                        }}
                      />
                      ) : (
                        <div className="video-main-image video-main-placeholder" aria-hidden>
                          加载中…
                        </div>
                      )
                    ) : exportPreviewUrl || mediaUrl ? (
                      <video
                        ref={videoRef}
                        key={exportPreviewUrl || mediaUrl}
                        src={exportPreviewUrl || mediaUrl}
                        controls={false}
                        playsInline
                        onTimeUpdate={() => {
                          const v = videoRef.current
                          if (!v) return
                          if (exportPreviewUrl && selectedExportPath) {
                            const exp = clipExports.find((e) => e.path === selectedExportPath)
                            if (exp && Number.isFinite(v.duration) && v.duration > 0) {
                              const ratio = clamp(v.currentTime / v.duration, 0, 1)
                              setCurrentTime(exp.start + ratio * (exp.end - exp.start))
                              return
                            }
                          }
                          setCurrentTime(v.currentTime)
                          const endT = previewEndRef.current
                          if (endT == null || !(endT > 0) || v.currentTime < endT - 0.04) return
                          const a = Math.min(selStartRef.current, selEndRef.current)
                          const b = Math.max(selStartRef.current, selEndRef.current)
                          if (loopSelectionRef.current && b - a >= 0.05 && !v.paused) {
                            if (selectionLoopGuardRef.current) return
                            selectionLoopGuardRef.current = true
                            try {
                              v.currentTime = a
                            } catch {
                              /* ignore */
                            }
                            setCurrentTime(a)
                            previewEndRef.current = b
                            window.setTimeout(() => {
                              selectionLoopGuardRef.current = false
                              const cur = videoRef.current
                              if (!cur || cur.paused) return
                              if (previewEndRef.current == null) return
                              void cur.play().catch(() => undefined)
                            }, 40)
                            return
                          }
                          try {
                            v.pause()
                          } catch {
                            /* ignore */
                          }
                          try {
                            v.currentTime = endT
                          } catch {
                            /* ignore */
                          }
                          previewEndRef.current = null
                          setCurrentTime(endT)
                        }}
                        onPlay={() => {
                          setStillFrameUrl(null)
                        }}
                        onLoadedMetadata={() => {
                          const v = videoRef.current
                          if (!v) return
                          if (!exportPreviewUrlRef.current) {
                            if (Number.isFinite(v.duration) && v.duration > 0) {
                              setDuration(v.duration)
                            }
                            if (v.videoWidth > 0 && v.videoHeight > 0) {
                              setVideoNatural({ w: v.videoWidth, h: v.videoHeight })
                            }
                            const frame = v.parentElement
                            if (frame) {
                              setFrameSize({ w: frame.clientWidth, h: frame.clientHeight })
                            }
                          }
                          const gen = ++playbackGenRef.current
                          v.playbackRate = playbackRate
                          previewEndRef.current = null
                          void v
                            .play()
                            .then(() => {
                              if (gen !== playbackGenRef.current) {
                                try {
                                  v.pause()
                                } catch {
                                  /* ignore */
                                }
                                return
                              }
                              setStillFrameUrl(null)
                            })
                            .catch(() => {
                              /* ignore */
                            })
                        }}
                        onError={() => {
                          const active = exportPreviewUrlRef.current || mediaUrlRef.current
                          if (!active) return
                          const v = videoRef.current
                          const src = v?.currentSrc || v?.src || ''
                          if (src && src !== active) return
                          // 导出片段预览失败不走源片代理
                          if (exportPreviewUrlRef.current) {
                            const err = v?.error
                            showToast(
                              `片段无法播放: ${err?.message || '未知错误'}`
                            )
                            setStatus('视频加载失败')
                            return
                          }
                          const sourcePath = playSourcePathRef.current
                          if (sourcePath && !previewProxyTriedRef.current) {
                            previewProxyTriedRef.current = true
                            setStatus('正在生成兼容预览…')
                            void (async () => {
                              try {
                                const proxy = await window.api.ensurePreviewProxy(sourcePath, true)
                                const url = await window.api.getMediaUrl(proxy.path)
                                setMediaUrl(url)
                                showToast('已切换为兼容预览')
                                setStatus('')
                              } catch (err) {
                                showToast(`视频无法播放：${String(err)}`)
                                setStatus('视频加载失败')
                              }
                            })()
                            return
                          }
                          const err = v?.error
                          showToast(
                            `视频无法播放（可能是编码不被支持）: ${err?.message || '未知错误'}`
                          )
                          setStatus('视频加载失败')
                        }}
                      />
                    ) : (
                      <div className="video-main-image video-main-placeholder" aria-hidden>
                        加载中…
                      </div>
                    )}
                    {stillFrameUrl && !cropActive && !currentIsImage && (
                      <img
                        className="video-still-overlay"
                        src={stillFrameUrl}
                        alt=""
                        draggable={false}
                      />
                    )}
                    {cropActive && cropContentLayout && (
                      <div
                        className={`crop-overlay ${cropCommitted ? '' : 'is-drawing'}`}
                        style={{
                          left: cropContentLayout.left,
                          top: cropContentLayout.top,
                          width: cropContentLayout.width,
                          height: cropContentLayout.height
                        }}
                        onMouseDown={cropCommitted ? undefined : startCropDraw}
                      >
                        {!cropCommitted && (
                          <div className="crop-draw-hint">按住拖拽框选裁切区域</div>
                        )}
                        {(cropCommitted || crop.width > 0.005 || crop.height > 0.005) && (
                          <div
                            className="crop-box"
                            style={{
                              left: `${crop.x * 100}%`,
                              top: `${crop.y * 100}%`,
                              width: `${Math.max(crop.width, 0.002) * 100}%`,
                              height: `${Math.max(crop.height, 0.002) * 100}%`
                            }}
                            onMouseDown={cropCommitted ? startCropDrag('move') : undefined}
                          >
                            {cropCommitted && (
                              <>
                                <div className="crop-handle nw" onMouseDown={startCropDrag('nw')} />
                                <div className="crop-handle ne" onMouseDown={startCropDrag('ne')} />
                                <div className="crop-handle sw" onMouseDown={startCropDrag('sw')} />
                                <div className="crop-handle se" onMouseDown={startCropDrag('se')} />
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {viewZoom > 1.001 && (
                  <div className="view-zoom-badge" title="双击画面复位">
                    {Math.round(viewZoom * 100)}%
                    <button type="button" onClick={resetViewZoom}>
                      复位
                    </button>
                  </div>
                )}
              </div>

              {!currentIsImage && (
              <div
                className="player-v-splitter"
                title="拖拽放大/缩小选帧区（选帧区与剪辑区都不会折叠）"
                onMouseDown={startPlayerSplitResize}
              />
              )}

              {!currentIsImage && (
              <>
              {/* 隐藏 scrub 视频：拖拽入出点时抓取附近帧 */}
              <video
                ref={scrubVideoRef}
                className="scrub-video-hidden"
                src={mediaUrl || undefined}
                muted
                preload="auto"
                playsInline
              />
              <div
                className="timeline-filmstrip-slot"
                style={{ flex: `0 0 ${filmstripHeight}px`, height: filmstripHeight }}
              >
                {filmstrip ? (
                  <div
                    className="frame-filmstrip"
                    style={
                      {
                        ['--video-ar' as string]:
                          videoNatural.w > 0 && videoNatural.h > 0
                            ? `${videoNatural.w} / ${videoNatural.h}`
                            : '16 / 9'
                      } as React.CSSProperties
                    }
                  >
                    <div className="frame-filmstrip-row">
                      {filmstrip.items.map((item, idx) => {
                        const a = Math.min(selStart, selEnd)
                        const b = Math.max(selStart, selEnd)
                        const tol = frameDuration(stepFps) * 0.51
                        const isStart = Math.abs(item.time - a) <= tol
                        const isEnd = Math.abs(item.time - b) <= tol
                        return (
                          <button
                            type="button"
                            key={`fs-${idx}-${Math.round(item.time * 1000)}`}
                            className={[
                              'filmstrip-cell',
                              item.center ? 'center' : '',
                              isStart ? 'sel-start' : '',
                              isEnd ? 'sel-end' : ''
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            title={
                              isStart && isEnd
                                ? `起始+末尾 · ${formatTime(item.time)}`
                                : isStart
                                  ? `片段起始 · ${formatTime(item.time)}`
                                  : isEnd
                                    ? `片段末尾 · ${formatTime(item.time)}`
                                    : `定为${filmstrip.which === 'in' ? '入点' : '出点'}并定格 · ${formatTime(item.time)}`
                            }
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              selectFilmstripFrame(filmstrip.which, item.time, item.url)
                            }}
                          >
                            {item.url ? (
                              <img src={item.url} alt="" draggable={false} />
                            ) : (
                              <div className="filmstrip-placeholder" />
                            )}
                            {item.center && <span className="filmstrip-center-mark" />}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="timeline-filmstrip-empty">
                    选段/拖动入出点时显示附近帧 · 拖拽上方分界线可放大选帧区
                  </div>
                )}
              </div>

              <div className="timeline" ref={timelineRef}>
                <div className="timeline-footer" ref={timelineFooterRef}>
                <div className="timeline-track" ref={trackRef} onMouseDown={onTrackPointer}>
                  {remaining.map((r, i) => {
                    const pct = rangeToPct(r.start, r.end)
                    return (
                      <div
                        key={`rem-${i}`}
                        className="remaining-seg"
                        style={{
                          left: `${pct.left}%`,
                          width: `${pct.width}%`
                        }}
                        title="点击：把选区移到此未分类片段"
                        onMouseDown={(e) => {
                          if (e.button !== 0) return
                          e.stopPropagation()
                          e.preventDefault()
                          if (selectedExportPath || exportPreviewUrl) {
                            setSelectedExportPath(null)
                            setExportPreviewUrl(null)
                            playbackGenRef.current++
                            previewEndRef.current = null
                          }
                          void clearCompletedMark()
                          exitFineTune()
                          const span = selectionSpanFromRemaining([r], duration)
                          selStartRef.current = span.start
                          selEndRef.current = span.end
                          setSelStart(span.start)
                          setSelEnd(span.end)
                          refocusTimelineToSelection(span.start, span.end)
                          setStatus('已选中未分类片段')
                        }}
                      />
                    )
                  })}
                  {clipExports.map((exp) => {
                    const selected = exp.path === selectedExportPath
                    const shade = categoryShadeStyle(exp.category, { selected, compact: true })
                    const pct = rangeToPct(exp.start, exp.end)
                    return (
                      <div
                        key={exp.path}
                        className={`export-seg ${selected ? 'selected' : ''} ${exp.approx ? 'approx' : ''}`}
                        style={{
                          left: `${pct.left}%`,
                          width: `${pct.width}%`,
                          background: shade.background,
                          boxShadow: shade.boxShadow
                        }}
                        title={`${exp.category} · ${formatTime(exp.start)}–${formatTime(exp.end)}${
                          exp.approx ? ' · 历史片段（时段为推算）' : ''
                        } · 点击预览 · Delete 删除`}
                        onMouseDown={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          selectExportClip(exp)
                        }}
                      >
                        <span className="export-seg-label">{exp.category}</span>
                      </div>
                    )
                  })}
                  {(() => {
                    const pct = rangeToPct(selStart, selEnd)
                    return (
                      <div
                        className={`selection-seg ${selectedExportPath ? 'readonly' : ''}`}
                        style={{
                          left: `${pct.left}%`,
                          width: `${pct.width}%`
                        }}
                      />
                    )
                  })()}
                  {!selectedExportPath && (
                    <>
                      <div
                        className="sel-handle in"
                        style={{ left: `${handleToPct(Math.min(selStart, selEnd))}%` }}
                        onMouseDown={startDragHandle('in')}
                        title="拖拽入点（热区偏左，避免挡住白色播放头）"
                      >
                        <span className="sel-marker" />
                      </div>
                      <div
                        className="sel-handle out"
                        style={{ left: `${handleToPct(Math.max(selStart, selEnd))}%` }}
                        onMouseDown={startDragHandle('out')}
                        title="拖拽出点（热区偏右，避免挡住白色播放头）"
                      >
                        <span className="sel-marker" />
                      </div>
                    </>
                  )}
                  {timelineMarkers.map((mk) => {
                    const left = timeToPct(mk.time)
                    if (left < -1 || left > 101) return null
                    return (
                      <button
                        key={mk.id}
                        type="button"
                        className="timeline-marker"
                        style={{ left: `${left}%` }}
                        title={`标记 ${formatTimecode(mk.time, stepFps)} · 单击清除（可撤回）`}
                        onMouseDown={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          removeTimelineMarker(mk.id)
                        }}
                      >
                        <span className="timeline-marker-pin" aria-hidden />
                      </button>
                    )
                  })}
                  <div
                    className="playhead"
                    style={{ left: `${timeToPct(currentTime)}%` }}
                    title="拖动白色播放头（可点顶部白块；与入点重叠时优先拖白头）"
                    onMouseDown={startPlayheadDrag}
                  />
                </div>

                <div className="controls">
                  <div className="playback-rate" title="播放倍速">
                    <span className="playback-rate-label">倍速</span>
                    <div className="playback-rate-options" role="group" aria-label="播放倍速">
                      {PLAYBACK_RATES.map((rate) => (
                        <button
                          key={rate}
                          type="button"
                          className={playbackRate === rate ? 'active' : ''}
                          disabled={!mediaUrl}
                          onClick={() => setPlaybackRate(rate)}
                        >
                          {rate === 1 ? '1×' : `${rate}×`}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="playback-rate" title="步进（帧/秒）">
                    <span className="playback-rate-label">步进</span>
                    <div className="playback-rate-options" role="group" aria-label="步进帧率">
                      {STEP_FPS_OPTIONS.map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          className={`step-fps-btn ${stepFps === opt ? 'active' : ''}`}
                          disabled={!mediaUrl}
                          onClick={() => setStepFps(opt)}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div
                    className="playback-rate"
                    title="选段后是否在时间轴上放大选区范围"
                  >
                    <span className="playback-rate-label">轴</span>
                    <div className="playback-rate-options" role="group" aria-label="选段后时间轴">
                      <button
                        type="button"
                        className={!timelineZoomOnSelect ? 'active' : ''}
                        disabled={!mediaUrl}
                        onClick={() => setTimelineModeFull()}
                        title="选段后保持全片时间轴"
                      >
                        全片
                      </button>
                      <button
                        type="button"
                        className={timelineZoomOnSelect ? 'active' : ''}
                        disabled={!mediaUrl}
                        onClick={() => setTimelineModeSelection()}
                        title="选段后放大到选区"
                      >
                        选区
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={loopSelection ? 'active-toggle' : ''}
                    disabled={!mediaUrl}
                    title="空格播放选区时是否循环（到出点后回到入点）"
                    onClick={() => setLoopSelection((v) => !v)}
                  >
                    {loopSelection ? '循环开' : '循环关'}
                  </button>
                  <button
                    type="button"
                    disabled={!mediaUrl}
                    title="在播放头添加标记（快捷键 M；Alt+M 清除）"
                    onClick={() => addTimelineMarker()}
                  >
                    标记
                  </button>
                  {timelineMarkers.length > 0 && (
                    <button
                      type="button"
                      title="清除全部时间轴标记（可撤回）"
                      onClick={() => clearTimelineMarkers()}
                    >
                      清标记
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (cropActive) {
                        cancelCropMode()
                        return
                      }
                      beginCropMode()
                    }}
                    title={
                      cropActive
                        ? '取消画面裁切，恢复为完整画面导出'
                        : '进入裁切：在画面上按住拖拽框选'
                    }
                  >
                    {cropActive ? '取消裁切' : '画面裁切'}
                  </button>
                  <button className="primary" disabled={!canSave} onClick={() => void openSaveModal()}>
                    保存片段
                  </button>
                  <button
                    className="danger"
                    disabled={busy || !selectedExportPath}
                    onClick={() => void deleteSelectedExport()}
                    title="删除当前选中的分类片段"
                  >
                    删除分类
                  </button>
                  {current?.completed ? (
                    <button
                      disabled={busy}
                      title="撤销已完成标记，可继续编辑"
                      onClick={() => void markCurrentIncomplete()}
                    >
                      撤销已完成
                    </button>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={async () => {
                        const ok = await finishCurrent()
                        if (ok) await goRelative(1)
                      }}
                    >
                      完成
                    </button>
                  )}
                </div>
                <div className="timeline-meta" aria-live="polite">
                  <span className="timeline-meta-timecode">
                    {formatTimelineTime(edgeDragTime ?? currentTime)}
                    <span className="timeline-meta-dim">
                      {' '}
                      / {formatTimelineTime(duration)} · f
                      {frameIndex(edgeDragTime ?? currentTime, stepFps)}
                      {loopSelection ? ' · 循环' : ''}
                      {timelineMarkers.length ? ` · 标记 ${timelineMarkers.length}` : ''}
                    </span>
                  </span>
                  <span className="timeline-meta-status">
                    <strong>
                      当前选段 {selectionMeta.lenText}秒
                    </strong>
                    （{formatTimelineTime(selectionMeta.a)}-
                    {formatTimelineTime(selectionMeta.b)}）/{' '}
                    {formatTimelineTime(duration)}
                  </span>
                  <span className="timeline-meta-index">
                    {index + 1}/{videos.length}
                    {visibleIndices.length !== videos.length
                      ? ` · 待处理 ${visibleIndices.length}`
                      : ''}
                    {clipExports.length > 0 ? ' · 有已导出片段' : ''}
                  </span>
                </div>
                </div>
              </div>
              </>
              )}

              {currentIsImage && (
                <div className="image-edit-panel">
                  {clipExports.length > 0 && (
                    <div className="image-export-chips">
                      <span className="image-export-label">已分类</span>
                      {clipExports.map((exp) => {
                        const selected = exp.path === selectedExportPath
                        const shade = categoryShadeStyle(exp.category, { selected, compact: true })
                        return (
                          <button
                            key={exp.path}
                            type="button"
                            className={`image-export-chip ${selected ? 'selected' : ''}`}
                            style={{ background: shade.background, boxShadow: shade.boxShadow }}
                            title={`${exp.category} · 点击预览 · Delete 删除`}
                            onClick={() => selectExportClip(exp)}
                          >
                            {exp.category}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  <div className="controls image-mode-controls">
                    <button
                      onClick={() => {
                        if (cropActive) {
                          cancelCropMode()
                          return
                        }
                        beginCropMode()
                      }}
                      title={cropActive ? '取消画面裁切' : '进入裁切：在画面上按住拖拽框选'}
                    >
                      {cropActive ? '取消裁切' : '画面裁切'}
                    </button>
                    <button className="primary" disabled={!canSave} onClick={() => void openSaveModal()}>
                      分类保存
                    </button>
                    <button
                      className="danger"
                      disabled={busy || !selectedExportPath}
                      onClick={() => void deleteSelectedExport()}
                      title="删除当前选中的分类结果"
                    >
                      删除分类
                    </button>
                    {current?.completed ? (
                      <button
                        disabled={busy}
                        title="撤销已完成标记，可继续编辑"
                        onClick={() => void markCurrentIncomplete()}
                      >
                        撤销已完成
                      </button>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={async () => {
                          const ok = await finishCurrent()
                          if (ok) await goRelative(1)
                        }}
                      >
                        完成
                      </button>
                    )}
                  </div>
                  <div className="timeline-meta" aria-live="polite">
                    <span className="timeline-meta-status">{status}</span>
                    <span className="timeline-meta-index">
                      {index + 1}/{videos.length}
                      {clipExports.length > 0 ? ' · 有已保存结果' : ''}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </main>
      </div>

      {saveModal && (
        <div className="modal-backdrop">
          <div className="modal modal-save">
            <h2>{currentIsImage ? '保存图片' : '保存片段'}</h2>
            <p>
              {currentIsImage
                ? saveModal.cropActive
                  ? '含画面裁切'
                  : '全画面'
                : `${formatTime(saveModal.start)} – ${formatTime(saveModal.end)}（${(
                    saveModal.end - saveModal.start
                  ).toFixed(1)}秒）${saveModal.cropActive ? ' · 含画面裁切' : ' · 全画面'}`}
            </p>
            <div className="save-clip-preview">
              {(() => {
                const c = saveModal.crop
                const cropOn =
                  saveModal.cropActive &&
                  c.width > 0.02 &&
                  c.height > 0.02 &&
                  !(c.x <= 0.001 && c.y <= 0.001 && c.width >= 0.999 && c.height >= 0.999)
                const vw = videoNatural.w > 0 ? videoNatural.w : 16
                const vh = videoNatural.h > 0 ? videoNatural.h : 9
                const previewAr = cropOn
                  ? `${vw * c.width} / ${vh * c.height}`
                  : `${vw} / ${vh}`
                return (
                  <div
                    className="save-clip-preview-stage"
                    style={{ ['--preview-ar' as string]: previewAr } as React.CSSProperties}
                  >
                    <div
                      className={`save-clip-preview-crop ${cropOn ? 'is-cropped' : ''}`}
                      style={
                        cropOn
                          ? {
                              width: `${100 / c.width}%`,
                              height: `${100 / c.height}%`,
                              left: `${(-c.x / c.width) * 100}%`,
                              top: `${(-c.y / c.height) * 100}%`
                            }
                          : undefined
                      }
                    >
                      {currentIsImage ? (
                        <img
                          key={`save-preview-img-${cropOn ? 'c' : 'f'}`}
                          src={saveModal.previewUrl}
                          alt=""
                          draggable={false}
                        />
                      ) : (
                      <video
                        ref={savePreviewRef}
                        key={`save-preview-${saveModal.start}-${saveModal.end}-${cropOn ? 'c' : 'f'}`}
                        src={saveModal.previewUrl}
                        playsInline
                        onClick={() => {
                          const v = savePreviewRef.current
                          if (!v) return
                          if (v.paused) {
                            void v.play().then(() => setSavePreviewPlaying(true)).catch(() => undefined)
                          } else {
                            v.pause()
                            setSavePreviewPlaying(false)
                          }
                        }}
                        onPlay={() => setSavePreviewPlaying(true)}
                        onPause={() => setSavePreviewPlaying(false)}
                        onTimeUpdate={(e) => {
                          const v = e.currentTarget
                          const a = saveModal.start
                          const b = Math.min(
                            saveModal.end,
                            Number.isFinite(v.duration) ? v.duration : saveModal.end
                          )
                          const len = Math.max(0.05, b - a)
                          if (savePreviewLoopGuardRef.current) return
                          if (v.currentTime < a - 0.08) {
                            v.currentTime = a
                            setSavePreviewLocal(0)
                            return
                          }
                          if (v.currentTime >= b - 0.04) {
                            savePreviewLoopGuardRef.current = true
                            try {
                              v.pause()
                            } catch {
                              /* ignore */
                            }
                            try {
                              v.currentTime = a
                            } catch {
                              /* ignore */
                            }
                            setSavePreviewLocal(0)
                            window.setTimeout(() => {
                              savePreviewLoopGuardRef.current = false
                              if (savePreviewRef.current !== v) return
                              void v.play().catch(() => undefined)
                            }, 40)
                            return
                          }
                          setSavePreviewLocal(clamp(v.currentTime - a, 0, len))
                        }}
                      />
                      )}
                    </div>
                    {!currentIsImage && (
                      <div className="save-clip-controls">
                        <input
                          className="save-clip-scrub"
                          type="range"
                          min={0}
                          max={Math.max(0.05, saveModal.end - saveModal.start)}
                          step={0.05}
                          value={clamp(
                            savePreviewLocal,
                            0,
                            Math.max(0.05, saveModal.end - saveModal.start)
                          )}
                          onChange={(e) => {
                            const v = savePreviewRef.current
                            const len = Math.max(0.05, saveModal.end - saveModal.start)
                            const local = clamp(Number(e.target.value), 0, len)
                            setSavePreviewLocal(local)
                            if (v) v.currentTime = saveModal.start + local
                          }}
                        />
                        <span className="save-clip-time">
                          {formatTime(savePreviewLocal)} /{' '}
                          {formatTime(Math.max(0, saveModal.end - saveModal.start))}
                        </span>
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
            <CategoryChips
              value={categoryInput}
              onSelect={onSaveCategorySelect}
              onConfirm={(tag) => void confirmSave(tag)}
              onRequestDelete={requestDeleteCategoryTag}
              refreshKey={categoryTagsRevision}
            />
            <label className="save-dest-label">保存路径</label>
            <div className="reclassify-custom-row save-dest-row">
              <input
                value={savePathDisplay}
                onChange={(e) => onSaveDestRootChange(e.target.value)}
                placeholder="选择类别后显示；可改源目录或点右侧选择"
                title={savePathDisplay || undefined}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.stopPropagation()
                    void confirmSave()
                  }
                }}
              />
              <button type="button" onClick={() => void pickSaveDestDir()}>
                选择…
              </button>
            </div>
            <p className="save-dest-hint">
              自定义的是类别文件夹的源目录，实际保存到「源目录/类别名/」。自定义后本次运行内一直沿用，重启后恢复默认
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setSaveModal(null)}>
                取消
              </button>
              <button type="button" className="primary" onClick={() => void confirmSave()}>
                确认保存
              </button>
            </div>
          </div>
        </div>
      )}

      {batchModal && (
        <div className="modal-backdrop">
          <div className="modal modal-save">
            <h2>批量分类</h2>
            <p>
              将选中的 {selectedVideos.length}{' '}
              个视频移动到类别文件夹（原目录不再保留）。支持一次撤回。
              {selectedVideos.some((v) => v.isCategoryCopy) ? (
                <>
                  <br />
                  含已归类项：确认后将选择二次分类落点
                  {reclassifyPrefDontAsk
                    ? `（当前默认：${reclassifyModeLabel(reclassifyMode)}）`
                    : ''}
                  {reclassifyPrefDontAsk ? (
                    <>
                      {' '}
                      <button type="button" className="linkish" onClick={clearReclassifyDontAsk}>
                        更改
                      </button>
                    </>
                  ) : null}
                </>
              ) : null}
            </p>
            <label>类别</label>
            <input
              value={batchCategory}
              onChange={(e) => setBatchCategory(e.target.value)}
              placeholder="点击下方标签，或自定义名称"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void confirmBatchClassify()
                }
              }}
            />
            <CategoryChips
              value={batchCategory}
              onSelect={setBatchCategory}
              onConfirm={() => void confirmBatchClassify()}
              onRequestDelete={requestDeleteCategoryTag}
              refreshKey={categoryTagsRevision}
            />
            <div className="modal-actions">
              <button onClick={() => setBatchModal(false)}>取消</button>
              <button className="primary" disabled={busy} onClick={() => void confirmBatchClassify()}>
                确认归类
              </button>
            </div>
          </div>
        </div>
      )}

      {reclassifyDestModal && (
        <div className="modal-backdrop">
          <div className="modal modal-reclassify">
            <h2>二次分类落点</h2>
            <p>
              选中项中有 {reclassifyDestModal.categorizedCount} 个已在类别文件夹内。
              请选择再次归类到「{reclassifyDestModal.category}」时的目标位置。
              未归类项仍移到各自所在目录下的类别文件夹。
            </p>
            <div className="radio-stack" role="radiogroup" aria-label="二次分类落点">
              <label className="radio-row">
                <input
                  type="radio"
                  name="reclassify-dest"
                  checked={reclassifyMode === 'originalRoot'}
                  onChange={() => setReclassifyMode('originalRoot')}
                />
                <span>
                  <strong>原目录对应类别</strong>
                  <span className="muted">
                    例：/素材库/走路/… → /素材库/{reclassifyDestModal.category}/…
                  </span>
                </span>
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  name="reclassify-dest"
                  checked={reclassifyMode === 'underCurrent'}
                  onChange={() => setReclassifyMode('underCurrent')}
                />
                <span>
                  <strong>当前目录下新建类别</strong>
                  <span className="muted">
                    例：/素材库/走路/… → /素材库/走路/{reclassifyDestModal.category}/…
                  </span>
                </span>
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  name="reclassify-dest"
                  checked={reclassifyMode === 'custom'}
                  onChange={() => setReclassifyMode('custom')}
                />
                <span>
                  <strong>自选目标文件夹</strong>
                  <span className="muted">直接写入所选目录，不再套一层类别名</span>
                </span>
              </label>
            </div>
            {reclassifyMode === 'custom' ? (
              <div className="reclassify-custom-row">
                <input
                  readOnly
                  value={reclassifyCustomDir}
                  placeholder="尚未选择目标文件夹"
                />
                <button type="button" onClick={() => void pickReclassifyCustomDir()}>
                  选择…
                </button>
              </div>
            ) : null}
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={reclassifyDontAsk}
                onChange={(e) => setReclassifyDontAsk(e.target.checked)}
              />
              不再询问（记住本次选择）
            </label>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  setReclassifyDestModal(null)
                  setBatchModal(true)
                }}
              >
                返回
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void confirmReclassifyDest()}
              >
                确认移动
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteCategoryTagModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>删除分类标签</h2>
            <p>
              确定删除自定义标签「<strong>{deleteCategoryTagModal.tag}</strong>」？
              <br />
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                仅从标签列表移除，已导出的分类文件不会被删除。
                <br />
                勾选「不再询问」后，本次运行期间将直接删除；重启应用后恢复询问。
              </span>
            </p>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={deleteCategoryTagDontAsk}
                onChange={(e) => setDeleteCategoryTagDontAsk(e.target.checked)}
              />
              不再询问
            </label>
            <div className="modal-actions">
              <button
                onClick={() => {
                  setDeleteCategoryTagDontAsk(false)
                  setDeleteCategoryTagModal(null)
                }}
              >
                取消
              </button>
              <button className="danger" onClick={confirmDeleteCategoryTag}>
                删除标签
              </button>
            </div>
          </div>
        </div>
      )}

      {whatsNewModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{whatsNewModal.title}</h2>
            <p>本版本更新内容：</p>
            <ul className="whats-new-list">
              {whatsNewModal.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="modal-actions">
              <button
                type="button"
                className="primary"
                onClick={() => dismissWhatsNew()}
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{confirmModal.title}</h2>
            <p>{confirmModal.message}</p>
            <div className="modal-actions">
              <button
                onClick={() => {
                  const cancel = confirmModal.onCancel
                  setConfirmModal(null)
                  cancel?.()
                }}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => {
                  const fn = confirmModal.onConfirm
                  setConfirmModal(null)
                  fn()
                }}
              >
                {confirmModal.confirmText || '确认'}
              </button>
            </div>
          </div>
        </div>
      )}

      {importChoiceModal && (
        <div className="modal-backdrop">
          <div className="modal modal-import-choice">
            <h2>选择加载内容</h2>
            <p>
              检测到该目录同时包含{' '}
              <strong>{importChoiceModal.videoCount}</strong> 个视频与{' '}
              <strong>{importChoiceModal.imageCount}</strong> 张图片，请选择要加载的范围：
            </p>
            <div className="modal-actions modal-actions-stack">
              <button
                type="button"
                className="primary"
                onClick={() => void resolveImportChoice('both')}
              >
                都加载（之后可在列表筛选）
              </button>
              <button type="button" onClick={() => void resolveImportChoice('video')}>
                只加载视频（{importChoiceModal.videoCount}）
              </button>
              <button type="button" onClick={() => void resolveImportChoice('image')}>
                只加载图片（{importChoiceModal.imageCount}）
              </button>
              <button type="button" onClick={() => setImportChoiceModal(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {batchResultModal && (
        <div className="modal-backdrop">
          <div className="modal modal-batch-result">
            <h2>批量分类结果 · {batchResultModal.category}</h2>
            {batchResultModal.cancelled && (
              <p className="batch-result-note">
                已中止。已成功移动的项仍在目标目录，可用「撤回批量分类」或 {MOD_KEY}+Z 还原；未处理项未改动。
              </p>
            )}
            <div className="batch-result-lists">
              <div>
                <h3>成功（{batchResultModal.results.filter((r) => r.ok).length}）</h3>
                <ul>
                  {batchResultModal.results
                    .filter((r) => r.ok)
                    .map((r) => (
                      <li key={r.path} title={r.exportPath || r.path}>
                        {r.path.split(/[/\\]/).pop()} → {r.exportPath?.split(/[/\\]/).slice(-2).join('/') || ''}
                      </li>
                    ))}
                </ul>
              </div>
              <div>
                <h3>失败（{batchResultModal.results.filter((r) => !r.ok).length}）</h3>
                <ul>
                  {batchResultModal.results
                    .filter((r) => !r.ok)
                    .map((r) => (
                      <li key={r.path}>
                        {r.path.split(/[/\\]/).pop()}：{r.error || '未知错误'}
                      </li>
                    ))}
                </ul>
              </div>
            </div>
            <div className="modal-actions">
              <button onClick={() => setBatchResultModal(null)}>关闭</button>
              {batchResultModal.canUndo && (
                <button
                  onClick={() => {
                    setBatchResultModal(null)
                    void undoBatchClassify()
                  }}
                >
                  撤回本次移动
                </button>
              )}
              {batchResultModal.results.some((r) => !r.ok) && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    const failed = batchResultModal.results.filter((r) => !r.ok).map((r) => r.path)
                    void retryBatchFailed(failed, batchResultModal.category)
                  }}
                >
                  重试失败项
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {recoverModal && recoverCurrent && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>发现未完成会话</h2>
            <p>
              {recoverCurrent.sourcePath}
              <br />
              已导出 {recoverCurrent.exports.length} 段。请选择：
              <br />
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                若源视频已移动或删除：请丢弃会话后，用「打开」重新选择所在目录；已导出片段仍保留在分类目录中。
              </span>
            </p>
            <div className="modal-actions">
              <button
                onClick={() => {
                  void window.api
                    .discardSession(recoverCurrent, false)
                    .then(() => {
                      showToast('已丢弃会话，保留已分类片段')
                      advanceRecover(recoverModal, setRecoverModal)
                    })
                    .catch((err: unknown) => showToast(String(err)))
                }}
              >
                丢弃会话（保留已分类片段）
              </button>
              <button
                className="danger"
                onClick={() => {
                  void window.api
                    .discardSession(recoverCurrent, true)
                    .then(() => {
                      showToast('已丢弃会话并删除已分类片段文件')
                      advanceRecover(recoverModal, setRecoverModal)
                    })
                    .catch((err: unknown) => showToast(String(err)))
                }}
              >
                丢弃会话（删除已分类片段）
              </button>
              <button
                className="primary"
                onClick={() => {
                  void (async () => {
                    try {
                      const src = recoverCurrent.sourcePath
                      const dir = src.replace(/[/\\][^/\\]+$/, '')
                      let list: VideoItem[] = []
                      try {
                        list = await window.api.scanPaths([dir])
                      } catch {
                        showToast(
                          '源视频所在目录已不存在或无法访问。请丢弃会话后，用「打开」重新选择目录。'
                        )
                        return
                      }
                      if (!list.some((v) => v.path === src)) {
                        try {
                          const scanned = await window.api.scanPaths([src])
                          list = [...scanned, ...list]
                        } catch {
                          /* 单文件也不存在 */
                        }
                      }
                      const i = list.findIndex((v) => v.path === src)
                      if (i < 0) {
                        showToast(
                          '源视频已移动或删除。请丢弃本会话后，用「打开」重新选择目录；已导出片段仍保留在分类目录中。'
                        )
                        return
                      }
                      setVideos(list)
                      setRecoverModal(null)
                      await loadVideoAt(i, list)
                    } catch (err: unknown) {
                      const msg = String(err)
                      if (msg.includes('不在已打开的媒体范围内') || msg.includes('不存在')) {
                        showToast(
                          '源视频已移动或删除。请丢弃会话后，用「打开」重新选择目录。'
                        )
                      } else {
                        showToast(msg)
                      }
                    }
                  })()
                }}
              >
                继续处理
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function advanceRecover(
  modal: RecoverModal,
  setRecoverModal: (m: RecoverModal | null) => void
): void {
  const next = modal.index + 1
  if (next >= modal.sessions.length) setRecoverModal(null)
  else setRecoverModal({ ...modal, index: next })
}
