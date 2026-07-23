import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { CropRect, ExportRecord, SessionState, UndoEntry } from '../shared/types'
import { MEDIA_EXTENSIONS } from '../shared/types'
import {
  computeRemainingFromExports,
  isCompletedFileName,
  sanitizeName,
  parseClipExportMeta,
  sourceStemForExport,
  withCompletedFileName,
  withoutCompletedFileName
} from '../shared/utils'
import { isPresetCategory } from '../shared/categories'
import {
  exportRootDirFor,
  resolveClassifyDestDir,
  type ClassifyDestOptions
} from './exportPaths'
import { probeVideo } from './ffmpeg'

const SESSION_DIR = (): string => path.join(app.getPath('userData'), 'sessions')
/** 完成并清工作区会话后仍保留：自定义源目录等导出路径的回看索引 */
const EXPORT_CATALOG_DIR = (): string => path.join(app.getPath('userData'), 'export-catalog')

export type { ClassifyDestOptions } from './exportPaths'

function sessionKeySource(sourcePath: string): string {
  // 去掉 `_done`，完成重命名后仍命中同一目录索引 / 会话迁移键
  const resolved = path.resolve(withoutCompletedFileName(sourcePath))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function sessionFileFor(sourcePath: string): string {
  // 统一 path.resolve，避免相对/绝对路径生成不同会话键；
  // Windows 路径大小写不敏感：再统一小写，避免对话框与拖放大小写不一致导致会话丢失
  const resolved = path.resolve(sourcePath)
  const keySource = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const key = Buffer.from(keySource).toString('base64url')
  return path.join(SESSION_DIR(), `${key}.json`)
}

/** 旧版会话键（未 resolve / 未做 Windows 大小写归一），仅用于读取迁移 */
function legacySessionFileFor(sourcePath: string): string {
  const key = Buffer.from(sourcePath).toString('base64url')
  return path.join(SESSION_DIR(), `${key}.json`)
}

/** 旧版旁路路径（仅读取兼容，新流程不再写入） */
function sidecarPath(sourcePath: string): string {
  return sourcePath + '.labelu.json'
}

function ensureSessionDir(): void {
  fs.mkdirSync(SESSION_DIR(), { recursive: true })
}

function exportCatalogFileFor(sourcePath: string): string {
  const key = Buffer.from(sessionKeySource(sourcePath)).toString('base64url')
  return path.join(EXPORT_CATALOG_DIR(), `${key}.json`)
}

type ExportCatalog = {
  version: 1
  sourceKey: string
  updatedAt: string
  exports: ExportRecord[]
}

export function saveExportCatalog(sourcePath: string, exports: ExportRecord[]): void {
  const precise = (exports || []).filter((e) => e?.path && e.end > e.start && !e.approx)
  const file = exportCatalogFileFor(sourcePath)
  try {
    if (precise.length === 0) {
      if (fs.existsSync(file)) fs.unlinkSync(file)
      return
    }
    fs.mkdirSync(EXPORT_CATALOG_DIR(), { recursive: true })
    const catalog: ExportCatalog = {
      version: 1,
      sourceKey: sessionKeySource(sourcePath),
      updatedAt: new Date().toISOString(),
      exports: precise.map((e) => ({
        path: path.resolve(e.path),
        start: e.start,
        end: e.end,
        category: e.category,
        crop: e.crop ?? null
      }))
    }
    fs.writeFileSync(file, JSON.stringify(catalog, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

function loadExportCatalog(sourcePath: string): ExportRecord[] {
  const file = exportCatalogFileFor(sourcePath)
  if (!fs.existsSync(file)) return []
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ExportCatalog
    const list = Array.isArray(raw?.exports) ? raw.exports : []
    return list
      .filter((e) => e?.path && Number(e.end) > Number(e.start))
      .map((e) => ({
        path: path.resolve(String(e.path)),
        start: Number(e.start),
        end: Number(e.end),
        category: String(e.category || '').trim() || '未命名',
        crop: e.crop ?? null
      }))
      .filter((e) => {
        try {
          return fs.existsSync(e.path)
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

export function clearExportCatalog(sourcePath: string): void {
  const file = exportCatalogFileFor(sourcePath)
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch {
    /* ignore */
  }
}

/** 启动白名单：所有导出目录索引中的路径 */
export function listAllExportCatalogPaths(): string[] {
  const dir = EXPORT_CATALOG_DIR()
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(dir, name), 'utf8')
        ) as ExportCatalog
        for (const e of raw.exports || []) {
          if (e?.path) out.push(path.resolve(String(e.path)))
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

export function saveSession(state: SessionState): void {
  ensureSessionDir()
  state.updatedAt = new Date().toISOString()
  fs.writeFileSync(sessionFileFor(state.sourcePath), JSON.stringify(state, null, 2), 'utf8')
  // 同步持久化导出索引，完成清会话后仍可回看（含 customRoot）
  saveExportCatalog(state.sourcePath, state.exports || [])
}

type SidecarExport = {
  start: number
  end: number
  category: string
  file: string
  crop?: CropRect | null
}

type SidecarFile = {
  version: 1
  duration: number
  updatedAt: string
  exports: SidecarExport[]
}

type ClipSidecarFile = {
  version: 1
  start: number
  end: number
  category: string
  crop?: CropRect | null
  sourceName?: string
}

function isUnderDir(absFile: string, dir: string): boolean {
  const root = path.resolve(dir)
  const target = path.resolve(absFile)
  if (process.platform === 'win32') {
    const r = root.toLowerCase()
    const t = target.toLowerCase()
    return t === r || t.startsWith(r + path.sep)
  }
  return target === root || target.startsWith(root + path.sep)
}

export function clipSidecarPath(exportFilePath: string): string {
  return exportFilePath + '.labelu-clip.json'
}

/** @deprecated 新导出把时段写进文件名；仅用于读取旧版旁路 */
function loadClipSidecar(exportFilePath: string): ClipSidecarFile | null {
  const file = clipSidecarPath(exportFilePath)
  if (!fs.existsSync(file)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ClipSidecarFile
    if (!raw || raw.version !== 1 || !(raw.end > raw.start)) return null
    return raw
  } catch {
    return null
  }
}

/** 优先从文件名解析时段/类别，其次读旧版 .labelu-clip.json */
function resolveClipTiming(
  exportFilePath: string
): { start: number; end: number; category?: string; crop?: CropRect | null } | null {
  const fromName = parseClipExportMeta(exportFilePath)
  if (fromName) {
    return {
      start: fromName.start,
      end: fromName.end,
      category: fromName.category || undefined,
      crop: fromName.crop ?? null
    }
  }
  const clip = loadClipSidecar(exportFilePath)
  if (!clip) return null
  return {
    start: clip.start,
    end: clip.end,
    category: clip.category,
    crop: clip.crop ?? null
  }
}

function readSidecarRaw(sourcePath: string): SidecarFile | null {
  const file = sidecarPath(sourcePath)
  if (!fs.existsSync(file)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SidecarFile
    if (!raw || raw.version !== 1 || !Array.isArray(raw.exports)) return null
    return raw
  } catch {
    return null
  }
}

/** 旁路 .labelu.json 仅读取旧数据；新流程用文件名自描述，不再写入 */

export function clearSidecar(sourcePath: string): void {
  const file = sidecarPath(sourcePath)
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
}

function categoryFromExportPath(exportPath: string): string {
  return path.basename(path.dirname(exportPath)) || '未命名'
}

/** 把无时间记录的历史片段，尽量塞进源片剩余空隙以便时间轴可见 */
function placeApproxExports(
  duration: number,
  known: ExportRecord[],
  orphans: { path: string; category: string; clipDur: number }[]
): ExportRecord[] {
  const placed: ExportRecord[] = []
  let occupied = [...known]
  for (const o of orphans) {
    const need = Math.max(0.05, Math.min(o.clipDur, Math.max(0.05, duration)))
    let ranges = computeRemainingFromExports(duration, occupied)
    ranges = [...ranges].sort((a, b) => b.end - b.start - (a.end - a.start))
    const gap = ranges.find((r) => r.end - r.start >= need - 0.05) || ranges[0]
    if (!gap || gap.end - gap.start < 0.05) continue
    const len = Math.min(need, gap.end - gap.start)
    const rec: ExportRecord = {
      path: o.path,
      start: gap.start,
      end: gap.start + len,
      category: o.category,
      approx: true
    }
    placed.push(rec)
    occupied = [...occupied, rec]
  }
  return placed
}

/**
 * 从旁路 JSON + 导出文件名时段（或旧版 .labelu-clip.json）+ 类别目录文件，重建完整分类会话。
 * 无时间记录的历史文件会标 approx 并放入剩余空隙，避免「磁盘有片、轴上看不见」。
 */
async function loadSidecarSession(sourcePath: string): Promise<SessionState | null> {
  const dir = path.dirname(sourcePath)
  const byPath = new Map<string, ExportRecord>()

  const raw = readSidecarRaw(sourcePath)
  for (const item of raw?.exports || []) {
    if (!item || !(item.end > item.start) || !item.file) continue
    const abs = path.resolve(dir, item.file)
    if (!isUnderDir(abs, dir) || !fs.existsSync(abs)) continue
    byPath.set(path.resolve(abs), {
      path: abs,
      start: item.start,
      end: item.end,
      category: String(item.category || '').trim() || '未命名',
      crop: item.crop ?? null
    })
  }

  // 导出目录索引（含源树外的 customRoot 落点）
  for (const e of loadExportCatalog(sourcePath)) {
    const key = path.resolve(e.path)
    if (byPath.has(key)) continue
    byPath.set(key, e)
  }

  const diskFiles = listCategoryExportFiles(sourcePath)
  for (const abs of diskFiles) {
    const key = path.resolve(abs)
    if (byPath.has(key)) continue
    const timing = resolveClipTiming(abs)
    if (timing && timing.end > timing.start) {
      byPath.set(key, {
        path: abs,
        start: timing.start,
        end: timing.end,
        category: timing.category || categoryFromExportPath(abs),
        crop: timing.crop ?? null
      })
    }
  }

  const known = Array.from(byPath.values()).filter((e) => e.end > e.start)
  const orphanPaths = diskFiles.filter((p) => !byPath.has(path.resolve(p)))
  const orphans: { path: string; category: string; clipDur: number }[] = []

  if (orphanPaths.length > 0) {
    for (const abs of orphanPaths) {
      try {
        const p = await probeVideo(abs)
        const dur = p.duration > 0 ? p.duration : 2
        orphans.push({
          path: abs,
          category: categoryFromExportPath(abs),
          clipDur: dur
        })
      } catch {
        orphans.push({
          path: abs,
          category: categoryFromExportPath(abs),
          clipDur: 2
        })
      }
    }
  }

  let duration =
    (typeof raw?.duration === 'number' && raw.duration > 0
      ? raw.duration
      : known.length
        ? Math.max(...known.map((e) => e.end))
        : 0) || 0

  if (!(duration > 0) && (known.length || orphans.length)) {
    try {
      const p = await probeVideo(sourcePath)
      if (p.duration > 0) duration = p.duration
    } catch {
      /* ignore */
    }
  }

  const approx = duration > 0 ? placeApproxExports(duration, known, orphans) : []
  const exports = [...known, ...approx].sort((a, b) => a.start - b.start || a.end - b.end)
  if (exports.length === 0) return null

  return {
    version: 1,
    sourcePath,
    updatedAt: raw?.updatedAt || new Date().toISOString(),
    duration,
    exports,
    // 剩余可剪区间只按精确段计算，推算段不占用可剪空间
    remainingRanges: computeRemainingFromExports(duration, known),
    undoStack: []
  }
}

/** 仅工作区会话（未完成编辑） */
export function loadWorkspaceSession(sourcePath: string): SessionState | null {
  const file = sessionFileFor(sourcePath)
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as SessionState
    } catch {
      return null
    }
  }
  // 迁移：旧版未 resolve / 未做 Windows 大小写归一的会话文件
  const legacy = legacySessionFileFor(sourcePath)
  if (legacy !== file && fs.existsSync(legacy)) {
    try {
      const state = JSON.parse(fs.readFileSync(legacy, 'utf8')) as SessionState
      try {
        fs.renameSync(legacy, file)
      } catch {
        /* ignore migrate failure; still return state */
      }
      return state
    } catch {
      return null
    }
  }
  return null
}

/** 优先工作区会话，否则读源视频旁路（已完成可回看分类） */
export async function loadSession(sourcePath: string): Promise<SessionState | null> {
  return loadWorkspaceSession(sourcePath) || (await loadSidecarSession(sourcePath))
}

export function clearSession(sourcePath: string): void {
  const file = sessionFileFor(sourcePath)
  if (fs.existsSync(file)) fs.unlinkSync(file)
  const legacy = legacySessionFileFor(sourcePath)
  if (legacy !== file && fs.existsSync(legacy)) {
    try {
      fs.unlinkSync(legacy)
    } catch {
      /* ignore */
    }
  }
}

export function listPendingSessions(): SessionState[] {
  ensureSessionDir()
  const result: SessionState[] = []
  for (const name of fs.readdirSync(SESSION_DIR())) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = fs.readFileSync(path.join(SESSION_DIR(), name), 'utf8')
      const state = JSON.parse(raw) as SessionState
      if (state?.sourcePath && state.exports?.length > 0) {
        result.push(state)
      }
    } catch {
      /* skip */
    }
  }
  return result
}

/** 从工作区移除：清会话与完成标记；可选删除磁盘上的源文件（已导出分类片段保留） */
export async function removeFromWorkspace(
  sourcePath: string,
  deleteSourceFile: boolean
): Promise<void> {
  clearSession(sourcePath)
  clearSidecar(sourcePath)
  clearExportCatalog(sourcePath)
  const cleared = await clearCompletedFlag(sourcePath)
  if (!deleteSourceFile) return
  const toDelete = fs.existsSync(cleared) ? cleared : sourcePath
  try {
    if (fs.existsSync(toDelete)) fs.unlinkSync(toDelete)
  } catch (err) {
    throw new Error(`无法删除原文件：${err instanceof Error ? err.message : String(err)}`)
  }
}

export function discardSession(state: SessionState, deleteExports: boolean): void {
  if (deleteExports) {
    for (const exp of state.exports) {
      try {
        if (fs.existsSync(exp.path)) fs.unlinkSync(exp.path)
      } catch {
        /* ignore */
      }
      try {
        const clipMeta = clipSidecarPath(exp.path)
        if (fs.existsSync(clipMeta)) fs.unlinkSync(clipMeta)
      } catch {
        /* ignore */
      }
    }
    clearExportCatalog(state.sourcePath)
  }
  clearSession(state.sourcePath)
  clearSidecar(state.sourcePath)
}

export function pushUndo(stack: UndoEntry[], entry: UndoEntry, max = 20): UndoEntry[] {
  const next = [...stack, entry]
  while (next.length > max) next.shift()
  return next
}

/** 旧版旁路完成标记（仅兼容读取/清理，不再新建） */
function completedFlagPath(sourcePath: string): string {
  return sourcePath + '.labelu.done'
}

function removeLegacyCompletedFlag(sourcePath: string): void {
  const p = completedFlagPath(sourcePath)
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch {
    /* ignore */
  }
}

/**
 * 标记已完成：在源文件名 stem 末尾加 `_done`（不写新文件）。
 * @returns 标记后的路径（可能已重命名）
 */
export async function markCompleted(sourcePath: string): Promise<string> {
  removeLegacyCompletedFlag(sourcePath)
  if (isCompletedFileName(sourcePath)) return sourcePath
  const dest = withCompletedFileName(sourcePath)
  if (pathsEqualResolved(dest, sourcePath)) return sourcePath
  try {
    if (!fs.existsSync(sourcePath)) return sourcePath
    if (fs.existsSync(dest) && !pathsEqualResolved(dest, sourcePath)) {
      throw new Error(`无法标记完成：已存在 ${path.basename(dest)}`)
    }
    await renameWithRetry(sourcePath, dest)
    removeLegacyCompletedFlag(dest)
    return dest
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('无法标记完成')) throw err
    throw new Error(`无法标记完成：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 文件名带 `_done`，或仍残留旧版 `.labelu.done` */
export function isCompleted(sourcePath: string): boolean {
  if (isCompletedFileName(sourcePath)) return true
  try {
    return fs.existsSync(completedFlagPath(sourcePath))
  } catch {
    return false
  }
}

function hasSidecarRecord(sourcePath: string): boolean {
  try {
    return fs.existsSync(sidecarPath(sourcePath))
  } catch {
    return false
  }
}

/**
 * 源视频旁是否已有分类结果：完成标记 / 旁路 JSON / 类别子目录中的导出片段。
 * 用于重开文件夹时自动识别「已处理过」的视频。
 */
export function isSourceClassified(sourcePath: string): boolean {
  if (isCompleted(sourcePath) || hasSidecarRecord(sourcePath)) return true
  return listCategoryExportFiles(sourcePath).length > 0
}

/** 同一次扫描内复用「父目录 → 类别子目录文件列表」，避免每个源视频重复 readdir */
let categoryScanCache: Map<string, { cat: string; files: string[] }[]> | null = null

export function beginCategoryScanCache(): void {
  categoryScanCache = new Map()
}

export function endCategoryScanCache(): void {
  categoryScanCache = null
}

/** 扫描并缓存「源父目录下的类别子目录 + 文件名列表」 */
function loadCategoryListsForDir(dir: string): { cat: string; files: string[] }[] {
  let catLists = categoryScanCache?.get(dir)
  if (catLists) return catLists

  catLists = []
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  for (const name of entries) {
    const catDir = path.join(dir, name)
    let st: fs.Stats
    try {
      st = fs.statSync(catDir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (!isPresetCategory(name)) continue
    let files: string[]
    try {
      files = fs.readdirSync(catDir)
    } catch {
      continue
    }
    catLists.push({ cat: name, files })
  }
  categoryScanCache?.set(dir, catLists)
  return catLists
}

/** 源父目录下已存在的类别子文件夹绝对路径（用于白名单，避免逐文件登记） */
export function listCategoryDirectories(sourceDir: string): string[] {
  const dir = path.resolve(sourceDir)
  return loadCategoryListsForDir(dir).map(({ cat }) => path.join(dir, cat))
}

/** 在源目录的类别子文件夹 + 导出目录索引中，查找属于该源视频的导出片段 */
export function listCategoryExportFiles(sourcePath: string): string[] {
  const dir = exportRootDirFor(sourcePath)
  const parentDirName = sanitizeName(path.basename(dir))
  const stem = sanitizeName(sourceStemForExport(sourcePath))
  const prefix = `${parentDirName}_${stem}_`
  const out: string[] = []
  const seen = new Set<string>()

  const add = (abs: string): void => {
    const key =
      process.platform === 'win32' ? path.resolve(abs).toLowerCase() : path.resolve(abs)
    if (seen.has(key)) return
    seen.add(key)
    out.push(path.resolve(abs))
  }

  const catLists = loadCategoryListsForDir(dir)
  for (const { cat, files } of catLists) {
    const catDir = path.join(dir, cat)
    for (const f of files) {
      if (!f.startsWith(prefix)) continue
      const ext = path.extname(f).toLowerCase()
      if (!(MEDIA_EXTENSIONS as readonly string[]).includes(ext)) continue
      add(path.join(catDir, f))
    }
  }

  // customRoot 等落在源树外的导出：完成清会话后仍靠索引回看
  for (const e of loadExportCatalog(sourcePath)) {
    add(e.path)
  }
  return out
}

/**
 * 撤销已完成：去掉文件名中的 `_done`，并清理旧版旁路标记。
 * @returns 撤销后的路径（可能已重命名）
 */
export async function clearCompletedFlag(sourcePath: string): Promise<string> {
  removeLegacyCompletedFlag(sourcePath)
  if (!isCompletedFileName(sourcePath)) return sourcePath
  const dest = withoutCompletedFileName(sourcePath)
  if (pathsEqualResolved(dest, sourcePath)) return sourcePath
  try {
    if (!fs.existsSync(sourcePath)) return dest
    if (fs.existsSync(dest) && !pathsEqualResolved(dest, sourcePath)) {
      throw new Error(`无法撤销完成：已存在 ${path.basename(dest)}`)
    }
    await renameWithRetry(sourcePath, dest)
    removeLegacyCompletedFlag(dest)
    return dest
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('无法撤销完成')) throw err
    throw new Error(`无法撤销完成：${err instanceof Error ? err.message : String(err)}`)
  }
}

type ClassifyResult = {
  /** 实际用于移动的源路径（可能已去掉 `_done`） */
  sourcePath: string
  exportPath: string
}

function pathsEqualResolved(a: string, b: string): boolean {
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  if (ra === rb) return true
  return process.platform === 'win32' && ra.toLowerCase() === rb.toLowerCase()
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Windows 上文件仍被播放器占用时 rename 常 EBUSY，短重试 */
async function renameWithRetry(src: string, dest: string): Promise<void> {
  let lastErr: unknown
  const attempts = process.platform === 'win32' ? 24 : 12
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(src, dest)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        await sleepMs(40 + i * 35)
        continue
      }
      throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 异步流式复制（避免大文件卡死主线程），并校验大小 */
async function copyFileVerified(src: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(src)
    const ws = fs.createWriteStream(dest)
    rs.on('error', reject)
    ws.on('error', reject)
    ws.on('finish', () => resolve())
    rs.pipe(ws)
  })
  const srcSize = fs.statSync(src).size
  const dstSize = fs.statSync(dest).size
  if (srcSize <= 0 || dstSize !== srcSize) {
    try {
      fs.unlinkSync(dest)
    } catch {
      /* ignore */
    }
    throw new Error(`复制校验失败（源 ${srcSize} 字节，目标 ${dstSize} 字节）`)
  }
}

/** 移动文件（同盘 rename；跨盘则复制后删除源），不保留原路径文件 */
export async function moveFileVerified(src: string, dest: string): Promise<void> {
  const a = path.resolve(src)
  const b = path.resolve(dest)
  if (pathsEqualResolved(a, b)) return
  try {
    await renameWithRetry(src, dest)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    // 占用类错误不再误走「跨盘复制」，直接抛出
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw err
    /* EXDEV 等：回退为复制后删除 */
  }
  await copyFileVerified(src, dest)
  try {
    fs.unlinkSync(src)
  } catch (err) {
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest)
    } catch {
      /* ignore */
    }
    throw err instanceof Error ? err : new Error(String(err))
  }
}

function uniqueDestPath(categoryDir: string, base: string): string {
  let dest = path.join(categoryDir, base)
  if (!fs.existsSync(dest)) return dest
  const ext = path.extname(base)
  const stem = path.basename(base, ext)
  let n = 2
  while (fs.existsSync(path.join(categoryDir, `${stem}_${n}${ext}`))) n++
  return path.join(categoryDir, `${stem}_${n}${ext}`)
}

export type BatchClassifyMove = { originalPath: string; newPath: string }

function batchUndoStorePath(): string {
  return path.join(app.getPath('userData'), 'batch-classify-undo.json')
}

/** 最近一次批量分类（仅当次进程内存，重启后不可撤） */
let lastBatchClassifyUndo: BatchClassifyMove[] | null = null

export function peekBatchClassifyUndo(): BatchClassifyMove[] | null {
  return lastBatchClassifyUndo
}

/** 追加撤回记录（重试失败项时与上一次成功移动合并） */
export function appendBatchClassifyUndo(moves: BatchClassifyMove[]): void {
  if (!moves.length) return
  const prev = lastBatchClassifyUndo || []
  const byNew = new Map(prev.map((m) => [path.resolve(m.newPath), m]))
  for (const m of moves) {
    byNew.set(path.resolve(m.newPath), m)
  }
  lastBatchClassifyUndo = Array.from(byNew.values())
}

export function clearBatchClassifyUndo(): void {
  lastBatchClassifyUndo = null
}

/** 取出并清除 */
export function takeBatchClassifyUndo(): BatchClassifyMove[] | null {
  const cur = lastBatchClassifyUndo
  lastBatchClassifyUndo = null
  return cur
}

export function restoreBatchClassifyUndo(moves: BatchClassifyMove[]): void {
  lastBatchClassifyUndo = moves.length > 0 ? moves : null
}

/** 清除旧版落盘撤回文件；批量撤回不再跨重启保留 */
export function initBatchUndoStore(): void {
  lastBatchClassifyUndo = null
  try {
    const f = batchUndoStorePath()
    if (fs.existsSync(f)) fs.unlinkSync(f)
  } catch {
    /* ignore */
  }
}

export async function undoBatchClassifyMoves(
  moves: BatchClassifyMove[]
): Promise<{ restored: number; errors: string[] }> {
  let restored = 0
  const errors: string[] = []
  for (const { originalPath, newPath } of [...moves].reverse()) {
    try {
      if (!fs.existsSync(newPath)) {
        errors.push(`找不到已分类文件：${path.basename(newPath)}`)
        continue
      }
      if (fs.existsSync(originalPath)) {
        errors.push(`原路径已被占用：${path.basename(originalPath)}`)
        continue
      }
      fs.mkdirSync(path.dirname(originalPath), { recursive: true })
      await moveFileVerified(newPath, originalPath)
      await clearCompletedFlag(originalPath)
      restored++
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  return { restored, errors }
}

export async function classifyWholeFileAsync(
  sourcePath: string,
  category: string,
  opts?: ClassifyDestOptions
): Promise<ClassifyResult> {
  const cat = sanitizeName(category)
  if (!cat) throw new Error('类别名无效')
  if (!fs.existsSync(sourcePath)) throw new Error('文件不存在')

  const categoryDir = resolveClassifyDestDir(sourcePath, cat, opts)
  const mode = opts?.reclassifyMode ?? 'originalRoot'
  const customFinal = mode === 'custom'

  if (!customFinal) {
    const root = path.dirname(categoryDir)
    const resolvedRoot = path.resolve(root)
    const resolvedCat = path.resolve(categoryDir)
    const catOk =
      process.platform === 'win32'
        ? resolvedCat.toLowerCase() === resolvedRoot.toLowerCase() ||
          resolvedCat.toLowerCase().startsWith(resolvedRoot.toLowerCase() + path.sep)
        : resolvedCat === resolvedRoot || resolvedCat.startsWith(resolvedRoot + path.sep)
    if (!catOk) {
      throw new Error('类别名无效')
    }
  }

  fs.mkdirSync(categoryDir, { recursive: true })

  const baseName = path.basename(withoutCompletedFileName(sourcePath))
  let dest = path.join(categoryDir, baseName)

  if (pathsEqualResolved(dest, sourcePath)) {
    clearSession(sourcePath)
    clearSidecar(sourcePath)
    await clearCompletedFlag(sourcePath)
    return { sourcePath, exportPath: sourcePath }
  }

  dest = uniqueDestPath(categoryDir, baseName)
  clearSession(sourcePath)
  clearSidecar(sourcePath)
  const fromPath = await clearCompletedFlag(sourcePath)
  await moveFileVerified(fromPath, dest)
  await clearCompletedFlag(dest)
  return { sourcePath: fromPath, exportPath: dest }
}
