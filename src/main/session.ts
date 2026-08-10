import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { CropRect, ExportRecord, SessionState, UndoEntry } from '../shared/types'
import { MEDIA_EXTENSIONS } from '../shared/types'
import {
  computeRemainingFromExports,
  friendlyFsError,
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
  // 同步持久化导出索引，完成清会话后仍可回看（含源树外的自选根目录）
  saveExportCatalog(state.sourcePath, state.exports || [])
}

function categoryFromExportPath(exportPath: string): string {
  return path.basename(path.dirname(exportPath)) || '未命名'
}

/** 仅从导出文件名解析时段/类别/裁切（无文件名时段则忽略该文件） */
function resolveClipTiming(
  exportFilePath: string
): { start: number; end: number; category?: string; crop?: CropRect | null } | null {
  const fromName = parseClipExportMeta(exportFilePath)
  if (!fromName || !(fromName.end > fromName.start)) return null
  return {
    start: fromName.start,
    end: fromName.end,
    category: fromName.category || undefined,
    crop: fromName.crop ?? null
  }
}

/**
 * 从导出文件名时段 + 导出目录索引 + 类别目录文件，重建回看用会话。
 * 无 `_s…_e…_` 时段的文件不会进入时间轴。
 */
async function loadDiskSession(sourcePath: string): Promise<SessionState | null> {
  const byPath = new Map<string, ExportRecord>()

  for (const e of loadExportCatalog(sourcePath)) {
    byPath.set(path.resolve(e.path), e)
  }

  const diskFiles = listCategoryExportFiles(sourcePath)
  for (const abs of diskFiles) {
    const key = path.resolve(abs)
    if (byPath.has(key)) continue
    const timing = resolveClipTiming(abs)
    if (!timing) continue
    byPath.set(key, {
      path: abs,
      start: timing.start,
      end: timing.end,
      category: timing.category || categoryFromExportPath(abs),
      crop: timing.crop ?? null
    })
  }

  const known = Array.from(byPath.values()).filter((e) => e.end > e.start)
  if (known.length === 0) return null

  // 必须以源片 probe 时长为准；勿用 max(export.end)，否则续剪时主进程会按偏短片长拒选区
  let duration = 0
  try {
    const p = await probeVideo(sourcePath)
    if (p.duration > 0) duration = p.duration
  } catch {
    /* ignore */
  }
  if (!(duration > 0)) {
    duration = Math.max(...known.map((e) => e.end), 0)
  }

  const exports = [...known].sort((a, b) => a.start - b.start || a.end - b.end)
  return {
    version: 1,
    sourcePath,
    updatedAt: new Date().toISOString(),
    duration,
    exports,
    remainingRanges: computeRemainingFromExports(duration, known),
    undoStack: []
  }
}

/** 仅工作区会话（未完成编辑） */
export function loadWorkspaceSession(sourcePath: string): SessionState | null {
  const file = sessionFileFor(sourcePath)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SessionState
  } catch {
    return null
  }
}

/** 优先工作区会话，否则从磁盘导出重建（已完成可回看分类） */
export async function loadSession(sourcePath: string): Promise<SessionState | null> {
  return loadWorkspaceSession(sourcePath) || (await loadDiskSession(sourcePath))
}

export function clearSession(sourcePath: string): void {
  const file = sessionFileFor(sourcePath)
  if (fs.existsSync(file)) fs.unlinkSync(file)
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
  clearExportCatalog(sourcePath)
  const cleared = await clearCompletedFlag(sourcePath)
  if (!deleteSourceFile) return
  const toDelete = fs.existsSync(cleared) ? cleared : sourcePath
  try {
    if (fs.existsSync(toDelete)) fs.unlinkSync(toDelete)
  } catch (err) {
    throw friendlyFsError(
      err,
      `无法删除原文件：${err instanceof Error ? err.message : String(err)}`
    )
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
    }
    clearExportCatalog(state.sourcePath)
  }
  clearSession(state.sourcePath)
}

export function pushUndo(stack: UndoEntry[], entry: UndoEntry, max = 20): UndoEntry[] {
  const next = [...stack, entry]
  while (next.length > max) next.shift()
  return next
}

/**
 * 标记已完成：在源文件名 stem 末尾加 `_done`（不写新文件）。
 * @returns 标记后的路径（可能已重命名）
 */
export async function markCompleted(sourcePath: string): Promise<string> {
  if (isCompletedFileName(sourcePath)) return sourcePath
  const dest = withCompletedFileName(sourcePath)
  if (pathsEqualResolved(dest, sourcePath)) return sourcePath
  try {
    if (!fs.existsSync(sourcePath)) return sourcePath
    if (fs.existsSync(dest) && !pathsEqualResolved(dest, sourcePath)) {
      throw new Error(`无法标记完成：已存在 ${path.basename(dest)}`)
    }
    await renameWithRetry(sourcePath, dest)
    return dest
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('无法标记完成')) throw err
    throw friendlyFsError(
      err,
      `无法标记完成：${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** 文件名带 `_done` */
export function isCompleted(sourcePath: string): boolean {
  return isCompletedFileName(sourcePath)
}

/**
 * 源视频旁是否已有分类结果：完成标记，或可解析时段的导出 / 导出目录索引。
 */
export function isSourceClassified(sourcePath: string): boolean {
  if (isCompleted(sourcePath)) return true
  if (loadExportCatalog(sourcePath).length > 0) return true
  for (const abs of listCategoryExportFiles(sourcePath)) {
    if (parseClipExportMeta(abs)) return true
  }
  return false
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
    const prefixKey =
      process.platform === 'win32' ? prefix.toLowerCase() : prefix
    for (const f of files) {
      const nameKey = process.platform === 'win32' ? f.toLowerCase() : f
      if (!nameKey.startsWith(prefixKey)) continue
      const ext = path.extname(f).toLowerCase()
      if (!(MEDIA_EXTENSIONS as readonly string[]).includes(ext)) continue
      add(path.join(catDir, f))
    }
  }

  // 自选根目录等落在源树外的导出：完成清会话后仍靠索引回看
  for (const e of loadExportCatalog(sourcePath)) {
    add(e.path)
  }
  return out
}

/**
 * 撤销已完成：去掉文件名中的 `_done`。
 * @returns 撤销后的路径（可能已重命名）
 */
export async function clearCompletedFlag(sourcePath: string): Promise<string> {
  if (!isCompletedFileName(sourcePath)) return sourcePath
  const dest = withoutCompletedFileName(sourcePath)
  if (pathsEqualResolved(dest, sourcePath)) return sourcePath
  try {
    if (!fs.existsSync(sourcePath)) return dest
    if (fs.existsSync(dest) && !pathsEqualResolved(dest, sourcePath)) {
      throw new Error(`无法撤销完成：已存在 ${path.basename(dest)}`)
    }
    await renameWithRetry(sourcePath, dest)
    return dest
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('无法撤销完成')) throw err
    throw friendlyFsError(
      err,
      `无法撤销完成：${err instanceof Error ? err.message : String(err)}`
    )
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
      if (code === 'ENAMETOOLONG') throw friendlyFsError(err)
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        await sleepMs(40 + i * 35)
        continue
      }
      throw friendlyFsError(err)
    }
  }
  throw friendlyFsError(lastErr)
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
    if (code === 'ENAMETOOLONG') throw friendlyFsError(err)
    // 占用类错误不再误走「跨盘复制」，直接抛出
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw err
    /* EXDEV 等：回退为复制后删除 */
  }
  try {
    await copyFileVerified(src, dest)
  } catch (err) {
    throw friendlyFsError(err)
  }
  {
    let lastUnlink: unknown
    const attempts = process.platform === 'win32' ? 24 : 12
    for (let i = 0; i < attempts; i++) {
      try {
        fs.unlinkSync(src)
        lastUnlink = null
        break
      } catch (err) {
        lastUnlink = err
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          await sleepMs(40 + i * 35)
          continue
        }
        break
      }
    }
    if (lastUnlink) {
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest)
      } catch {
        /* ignore */
      }
      throw friendlyFsError(lastUnlink)
    }
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

export async function undoBatchClassifyMoves(
  moves: BatchClassifyMove[]
): Promise<{ restored: number; errors: string[] }> {
  let restored = 0
  const errors: string[] = []
  for (const { originalPath, newPath } of [...moves].reverse()) {
    try {
      if (!fs.existsSync(newPath)) {
        errors.push(
          `当前文件已删除或不存在，无法撤回：${path.basename(newPath)}`
        )
        continue
      }
      if (fs.existsSync(originalPath)) {
        errors.push(`原路径已被占用，无法移回：${path.basename(originalPath)}`)
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

  fs.mkdirSync(categoryDir, { recursive: true })

  const baseName = path.basename(withoutCompletedFileName(sourcePath))
  let dest = path.join(categoryDir, baseName)

  try {
    if (pathsEqualResolved(dest, sourcePath)) {
      clearSession(sourcePath)
      await clearCompletedFlag(sourcePath)
      return { sourcePath, exportPath: sourcePath }
    }

    dest = uniqueDestPath(categoryDir, baseName)
    clearSession(sourcePath)
    const fromPath = await clearCompletedFlag(sourcePath)
    await moveFileVerified(fromPath, dest)
    await clearCompletedFlag(dest)
    return { sourcePath: fromPath, exportPath: dest }
  } catch (err) {
    throw friendlyFsError(err)
  }
}
