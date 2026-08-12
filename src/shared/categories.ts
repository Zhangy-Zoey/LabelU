import { sanitizeName } from './utils'

export type TaskKind = 'factory-cat' | 'factory-dog' | 'custom'

export type CategoryTag = {
  id: string
  name: string
  /** 空 / null = 继承所属大类颜色 */
  color?: string | null
}

export type CategoryGroup = {
  id: string
  title: string
  color: string
  tags: CategoryTag[]
}

export type ClassifyTask = {
  id: string
  name: string
  kind: TaskKind
  groups: CategoryGroup[]
}

export type ClassifyTasksPersistPayload = {
  version: 1
  tasks: ClassifyTask[]
  activeTaskId: string
}

export const MAX_CUSTOM_TASKS = 3

/** 标签/大类可选色：赤橙黄绿青蓝紫的柔和奶奶色 */
export const MORANDI_COLORS = [
  '#c9a5a5', // 赤
  '#d4b59a', // 橙
  '#d4c9a8', // 黄
  '#a8b5a0', // 绿
  '#a3b8b5', // 青
  '#a8b5c4', // 蓝
  '#b8a9c0' // 紫
] as const

export type MorandiColor = (typeof MORANDI_COLORS)[number]

const GROUP_COLOR = {
  normal: MORANDI_COLORS[3], // 绿
  abnormal: MORANDI_COLORS[0], // 赤
  danger: MORANDI_COLORS[1], // 橙
  other: MORANDI_COLORS[5] // 蓝
} as const

const CATEGORY_PALETTE = [...MORANDI_COLORS]

const LS_CLASSIFY_TASKS = 'labelu.classifyTasks'

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function tag(name: string, color?: string | null): CategoryTag {
  return { id: newId('tag'), name, color: color ?? null }
}

function group(title: string, color: string, names: string[]): CategoryGroup {
  return {
    id: newId('grp'),
    title,
    color,
    tags: names.map((n) => tag(n))
  }
}

/** 出厂「猫」任务（内容等同原默认标签） */
export function createFactoryCatTask(): ClassifyTask {
  return {
    id: newId('task'),
    name: '猫',
    kind: 'factory-cat',
    groups: [
      group('正常行为', GROUP_COLOR.normal, [
        '吃饭',
        '喝水',
        '玩玩具',
        '蹦跳/跑酷',
        '上厕所',
        '咬尾巴',
        '嗅闻',
        '漫步',
        '刨地',
        '磨爪子',
        '踩奶',
        '舔毛',
        '洗脸/舔前爪',
        '其他活跃'
      ]),
      group('病理行为', GROUP_COLOR.abnormal, [
        '呕吐',
        '咳嗽',
        '打喷嚏',
        '抓挠/舔咬',
        '甩头',
        '擦肛',
        '跛行',
        '瘫痪',
        '抽搐'
      ]),
      group('破坏性行为', GROUP_COLOR.danger, [
        '咬家具',
        '开门',
        '打架',
        '咬电线',
        '掏墙',
        '翻垃圾',
        '吃屎'
      ]),
      group('其他', GROUP_COLOR.other, ['其他', '删除'])
    ]
  }
}

/** 出厂「狗」任务 */
export function createFactoryDogTask(): ClassifyTask {
  return {
    id: newId('task'),
    name: '狗',
    kind: 'factory-dog',
    groups: [
      group('正常行为', GROUP_COLOR.normal, [
        '进食',
        '喝水',
        '上厕所-小便',
        '上厕所-大便',
        '漫步',
        '直立',
        '横向跑跳',
        '转圈圈',
        '露肚皮',
        '站着玩',
        '侧躺玩',
        '趴着玩',
        '蹲坐玩',
        '站立',
        '侧躺',
        '趴着',
        '蹲坐'
      ]),
      group('危险行为', GROUP_COLOR.danger, ['吃屎', '啃咬']),
      group('病理行为', GROUP_COLOR.abnormal, [
        '呕吐',
        '咳嗽',
        '打喷嚏',
        '抓挠',
        '舔咬',
        '甩头',
        '擦肛',
        '跛行',
        '瘫痪',
        '抽搐'
      ]),
      group('其他', GROUP_COLOR.other, ['其他'])
    ]
  }
}

function defaultState(): ClassifyTasksPersistPayload {
  const cat = createFactoryCatTask()
  const dog = createFactoryDogTask()
  return { version: 1, tasks: [cat, dog], activeTaskId: cat.id }
}

let state: ClassifyTasksPersistPayload = defaultState()
let knownTagSet = new Set<string>()

/**
 * 标签查找键：统一小写。
 * Windows / 默认 macOS 卷均为大小写不敏感；避免目录「Run」与标签「run」对不上。
 */
function categoryLookupKey(name: string): string {
  return name.trim().toLowerCase()
}

function addTagVariants(set: Set<string>, tagName: string): void {
  const t = tagName.trim()
  if (!t) return
  set.add(categoryLookupKey(t))
  const dirAlias = sanitizeName(t)
  if (dirAlias) set.add(categoryLookupKey(dirAlias))
}

function rebuildKnownTagSet(): void {
  knownTagSet = new Set<string>()
  for (const task of state.tasks) {
    for (const g of task.groups) {
      for (const t of g.tags) addTagVariants(knownTagSet, t.name)
    }
  }
}

function ensureActiveTask(): void {
  if (state.tasks.some((t) => t.id === state.activeTaskId)) return
  state.activeTaskId = state.tasks[0]?.id ?? ''
}

function findTask(taskId: string): ClassifyTask | null {
  return state.tasks.find((t) => t.id === taskId) ?? null
}

function findActiveTask(): ClassifyTask | null {
  ensureActiveTask()
  return findTask(state.activeTaskId)
}

function taskByName(name: string): ClassifyTask | null {
  const key = name.trim()
  if (!key) return null
  return state.tasks.find((t) => t.name === key) ?? null
}

function countCustomTasks(): number {
  return state.tasks.filter((t) => t.kind === 'custom').length
}

function validateLabelName(raw: string, kind: '标签' | '大类' | '任务'): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: `请输入${kind}名` }
  if (trimmed === '.' || trimmed === '..' || /^\.+$/.test(trimmed)) {
    return { ok: false, error: `${kind}名无效` }
  }
  if (kind === '标签') {
    const name = sanitizeName(trimmed)
    if (!name || name === 'unnamed') return { ok: false, error: '标签名无效' }
    if (name.length > 32) return { ok: false, error: '标签名过长' }
    return { ok: true, name }
  }
  if (trimmed.length > 32) return { ok: false, error: `${kind}名过长` }
  return { ok: true, name: trimmed }
}

function normalizeColor(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const t = String(raw).trim()
  if (!t) return null
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(t)) {
    const r = t[1]
    const g = t[2]
    const b = t[3]
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return null
}

function parseHexRgb(hex: string): { r: number; g: number; b: number } | null {
  const c = hex.trim().toLowerCase()
  if (!/^#[0-9a-f]{6}$/.test(c)) return null
  return {
    r: parseInt(c.slice(1, 3), 16),
    g: parseInt(c.slice(3, 5), 16),
    b: parseInt(c.slice(5, 7), 16)
  }
}

/** 将任意色吸附到最近的莫兰迪色 */
export function nearestMorandiColor(raw: string | null | undefined): MorandiColor {
  const rgb = parseHexRgb(normalizeColor(raw) || '')
  if (!rgb) return MORANDI_COLORS[0]
  let best: MorandiColor = MORANDI_COLORS[0]
  let bestDist = Infinity
  for (const c of MORANDI_COLORS) {
    const p = parseHexRgb(c)!
    const d = (p.r - rgb.r) ** 2 + (p.g - rgb.g) ** 2 + (p.b - rgb.b) ** 2
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

function hashColor(name: string): string {
  const key = name.trim() || 'unnamed'
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return CATEGORY_PALETTE[Math.abs(h) % CATEGORY_PALETTE.length]
}

function resolveTagColor(group: CategoryGroup, tagItem: CategoryTag): string {
  return normalizeColor(tagItem.color) || normalizeColor(group.color) || hashColor(tagItem.name)
}

function findTagInTask(
  task: ClassifyTask,
  name: string
): { group: CategoryGroup; tag: CategoryTag; groupIndex: number; tagIndex: number } | null {
  const key = categoryLookupKey(name)
  for (let gi = 0; gi < task.groups.length; gi++) {
    const g = task.groups[gi]
    for (let ti = 0; ti < g.tags.length; ti++) {
      const t = g.tags[ti]
      if (categoryLookupKey(t.name) === key) return { group: g, tag: t, groupIndex: gi, tagIndex: ti }
    }
  }
  return null
}

function sanitizePersisted(raw: unknown): ClassifyTasksPersistPayload {
  const fallback = defaultState()
  if (!raw || typeof raw !== 'object') return fallback
  const obj = raw as Partial<ClassifyTasksPersistPayload>
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) return fallback

  const tasks: ClassifyTask[] = []
  const usedNames = new Set<string>()
  for (const item of obj.tasks) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name || '').trim()
    if (!name || usedNames.has(name)) continue
    const kind: TaskKind =
      item.kind === 'factory-cat' || item.kind === 'factory-dog' || item.kind === 'custom'
        ? item.kind
        : 'custom'
    if (kind === 'custom' && tasks.filter((t) => t.kind === 'custom').length >= MAX_CUSTOM_TASKS) {
      continue
    }
    const groups: CategoryGroup[] = []
    if (Array.isArray(item.groups)) {
      for (const g of item.groups) {
        if (!g || typeof g !== 'object') continue
        const title = String(g.title || '').trim()
        if (!title) continue
        const color = nearestMorandiColor(g.color)
        const tags: CategoryTag[] = []
        const tagKeys = new Set<string>()
        if (Array.isArray(g.tags)) {
          for (const t of g.tags) {
            if (!t || typeof t !== 'object') continue
            const tagName = String(t.name || '').trim()
            if (!tagName) continue
            const key = categoryLookupKey(tagName)
            if (tagKeys.has(key)) continue
            tagKeys.add(key)
            tags.push({
              id: String(t.id || '').trim() || newId('tag'),
              name: tagName,
              color: normalizeColor(t.color) ? nearestMorandiColor(t.color) : null
            })
          }
        }
        groups.push({
          id: String(g.id || '').trim() || newId('grp'),
          title,
          color,
          tags
        })
      }
    }
    usedNames.add(name)
    tasks.push({
      id: String(item.id || '').trim() || newId('task'),
      name,
      kind,
      groups
    })
  }
  if (tasks.length === 0) return fallback
  const activeTaskId =
    typeof obj.activeTaskId === 'string' && tasks.some((t) => t.id === obj.activeTaskId)
      ? obj.activeTaskId
      : tasks[0].id
  return { version: 1, tasks, activeTaskId }
}

rebuildKnownTagSet()

export function getClassifyTasksPersistPayload(): ClassifyTasksPersistPayload {
  return {
    version: 1,
    activeTaskId: state.activeTaskId,
    tasks: state.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      kind: task.kind,
      groups: task.groups.map((g) => ({
        id: g.id,
        title: g.title,
        color: g.color,
        tags: g.tags.map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color ?? null
        }))
      }))
    }))
  }
}

export function applyClassifyTasksPersistPayload(
  payload: ClassifyTasksPersistPayload | null | undefined
): void {
  state = sanitizePersisted(payload)
  ensureActiveTask()
  rebuildKnownTagSet()
}

export function loadClassifyTasks(): void {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(LS_CLASSIFY_TASKS)
    if (!raw) return
    applyClassifyTasksPersistPayload(JSON.parse(raw) as ClassifyTasksPersistPayload)
  } catch {
    /* ignore */
  }
}

export function saveClassifyTasks(): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(LS_CLASSIFY_TASKS, JSON.stringify(getClassifyTasksPersistPayload()))
  } catch {
    /* ignore */
  }
}

export function listClassifyTasks(): ClassifyTask[] {
  return getClassifyTasksPersistPayload().tasks
}

export function getActiveClassifyTask(): ClassifyTask | null {
  const task = findActiveTask()
  if (!task) return null
  return getClassifyTasksPersistPayload().tasks.find((t) => t.id === task.id) ?? null
}

export function getActiveTaskGroups(): CategoryGroup[] {
  return getActiveClassifyTask()?.groups.map((g) => ({
    ...g,
    tags: g.tags.map((t) => ({ ...t }))
  })) ?? []
}

export function setActiveClassifyTask(
  taskId: string
): { ok: true } | { ok: false; error: string } {
  if (!findTask(taskId)) return { ok: false, error: '任务不存在' }
  state.activeTaskId = taskId
  return { ok: true }
}

export function createCustomClassifyTask(
  rawName: string
): { ok: true; task: ClassifyTask } | { ok: false; error: string } {
  if (countCustomTasks() >= MAX_CUSTOM_TASKS) {
    return { ok: false, error: `自定义任务最多 ${MAX_CUSTOM_TASKS} 个` }
  }
  const validated = validateLabelName(rawName, '任务')
  if (!validated.ok) return validated
  if (taskByName(validated.name)) return { ok: false, error: '任务名已存在' }
  const task: ClassifyTask = {
    id: newId('task'),
    name: validated.name,
    kind: 'custom',
    groups: []
  }
  state.tasks.push(task)
  state.activeTaskId = task.id
  rebuildKnownTagSet()
  return {
    ok: true,
    task: {
      id: task.id,
      name: task.name,
      kind: task.kind,
      groups: []
    }
  }
}

export function renameClassifyTask(
  taskId: string,
  rawName: string
): { ok: true; name: string } | { ok: false; error: string } {
  const task = findTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  const validated = validateLabelName(rawName, '任务')
  if (!validated.ok) return validated
  const clash = taskByName(validated.name)
  if (clash && clash.id !== taskId) return { ok: false, error: '任务名已存在' }
  task.name = validated.name
  return { ok: true, name: validated.name }
}

export function deleteClassifyTask(
  taskId: string
): { ok: true } | { ok: false; error: string } {
  if (state.tasks.length <= 1) return { ok: false, error: '至少保留一个任务' }
  const idx = state.tasks.findIndex((t) => t.id === taskId)
  if (idx < 0) return { ok: false, error: '任务不存在' }
  state.tasks.splice(idx, 1)
  ensureActiveTask()
  rebuildKnownTagSet()
  return { ok: true }
}

/**
 * 恢复出厂「猫」「狗」：
 * - 缺失则新增
 * - 已存在同名则把大类/标签/颜色重置为出厂（保留任务 id，避免打断当前选中）
 */
export function restoreFactoryClassifyTasks(): {
  ok: true
  added: string[]
  reset: string[]
} {
  const added: string[] = []
  const reset: string[] = []

  const applyFactory = (name: '猫' | '狗', factory: ClassifyTask): void => {
    const existing = taskByName(name)
    if (!existing) {
      state.tasks.push(factory)
      added.push(name)
      return
    }
    existing.kind = factory.kind
    existing.groups = factory.groups
    reset.push(name)
  }

  applyFactory('猫', createFactoryCatTask())
  applyFactory('狗', createFactoryDogTask())
  ensureActiveTask()
  rebuildKnownTagSet()
  return { ok: true, added, reset }
}

export function addCategoryGroup(
  rawTitle: string,
  color?: string | null
): { ok: true; group: CategoryGroup } | { ok: false; error: string } {
  const task = findActiveTask()
  if (!task) return { ok: false, error: '无可用任务' }
  const validated = validateLabelName(rawTitle, '大类')
  if (!validated.ok) return validated
  if (task.groups.some((g) => g.title === validated.name)) {
    return { ok: false, error: '大类名已存在' }
  }
  const g: CategoryGroup = {
    id: newId('grp'),
    title: validated.name,
    color: nearestMorandiColor(color),
    tags: []
  }
  task.groups.push(g)
  return { ok: true, group: { ...g, tags: [] } }
}

export function updateCategoryGroup(
  groupId: string,
  patch: { title?: string; color?: string | null }
): { ok: true } | { ok: false; error: string } {
  const task = findActiveTask()
  if (!task) return { ok: false, error: '无可用任务' }
  const g = task.groups.find((x) => x.id === groupId)
  if (!g) return { ok: false, error: '未找到大类' }
  if (patch.title != null) {
    const validated = validateLabelName(patch.title, '大类')
    if (!validated.ok) return validated
    if (task.groups.some((x) => x.id !== groupId && x.title === validated.name)) {
      return { ok: false, error: '大类名已存在' }
    }
    g.title = validated.name
  }
  if (patch.color !== undefined) {
    const c = normalizeColor(patch.color)
    if (!c) return { ok: false, error: '请选择颜色' }
    g.color = nearestMorandiColor(c)
  }
  return { ok: true }
}

export function removeCategoryGroup(
  groupId: string
): { ok: true } | { ok: false; error: string } {
  const task = findActiveTask()
  if (!task) return { ok: false, error: '无可用任务' }
  const idx = task.groups.findIndex((g) => g.id === groupId)
  if (idx < 0) return { ok: false, error: '未找到大类' }
  task.groups.splice(idx, 1)
  rebuildKnownTagSet()
  return { ok: true }
}

export function reorderCategoryGroups(
  fromIndex: number,
  toIndex: number
): { ok: true } | { ok: false; error: string } {
  const task = findActiveTask()
  if (!task) return { ok: false, error: '无可用任务' }
  const list = task.groups
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= list.length ||
    toIndex >= list.length ||
    fromIndex === toIndex
  ) {
    return { ok: false, error: '无效位置' }
  }
  const [item] = list.splice(fromIndex, 1)
  list.splice(toIndex, 0, item)
  return { ok: true }
}

export function tryAddCategoryTag(
  groupId: string,
  rawName: string,
  color?: string | null
): { ok: true; name: string } | { ok: false; error: string } {
  const task = findActiveTask()
  if (!task) return { ok: false, error: '无可用任务' }
  const g = task.groups.find((x) => x.id === groupId)
  if (!g) return { ok: false, error: '未找到大类' }
  const validated = validateLabelName(rawName, '标签')
  if (!validated.ok) return validated
  if (findTagInTask(task, validated.name)) return { ok: false, error: '该标签已存在' }
  g.tags.push({
    id: newId('tag'),
    name: validated.name,
    color: normalizeColor(color) ? nearestMorandiColor(color) : null
  })
  rebuildKnownTagSet()
  return { ok: true, name: validated.name }
}

export function updateCategoryTag(
  tagId: string,
  patch: { name?: string; color?: string | null }
): { ok: true; name: string } | { ok: false; error: string } {
  const task = findActiveTask()
  if (!task) return { ok: false, error: '无可用任务' }
  let found: { group: CategoryGroup; tag: CategoryTag } | null = null
  for (const g of task.groups) {
    const t = g.tags.find((x) => x.id === tagId)
    if (t) {
      found = { group: g, tag: t }
      break
    }
  }
  if (!found) return { ok: false, error: '未找到标签' }
  if (patch.name != null) {
    const validated = validateLabelName(patch.name, '标签')
    if (!validated.ok) return validated
    const clash = findTagInTask(task, validated.name)
    if (clash && clash.tag.id !== tagId) return { ok: false, error: '该标签已存在' }
    found.tag.name = validated.name
  }
  if (patch.color !== undefined) {
    found.tag.color = normalizeColor(patch.color) ? nearestMorandiColor(patch.color) : null
  }
  rebuildKnownTagSet()
  return { ok: true, name: found.tag.name }
}

export function tryRemoveCategoryTag(
  rawName: string
):
  | { ok: true; name: string; groupId: string }
  | { ok: false; error: string } {
  const task = findActiveTask()
  if (!task) return { ok: false, error: '无可用任务' }
  const hit = findTagInTask(task, rawName)
  if (!hit) return { ok: false, error: '未找到该标签' }
  hit.group.tags.splice(hit.tagIndex, 1)
  rebuildKnownTagSet()
  return { ok: true, name: hit.tag.name, groupId: hit.group.id }
}

export function reorderCategoryTags(
  groupId: string,
  fromIndex: number,
  toIndex: number
): { ok: true } | { ok: false; error: string } {
  const task = findActiveTask()
  if (!task) return { ok: false, error: '无可用任务' }
  const g = task.groups.find((x) => x.id === groupId)
  if (!g) return { ok: false, error: '未找到大类' }
  const list = g.tags
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= list.length ||
    toIndex >= list.length ||
    fromIndex === toIndex
  ) {
    return { ok: false, error: '无效位置' }
  }
  const [item] = list.splice(fromIndex, 1)
  list.splice(toIndex, 0, item)
  return { ok: true }
}

/** 当前任务中是否存在该可见标签 */
export function findVisibleCategoryGroup(name: string): string | null {
  const task = findActiveTask()
  if (!task) return null
  const hit = findTagInTask(task, name)
  return hit?.group.id ?? null
}

/** 预设或用户配置中的标签（所有任务合计，供目录识别） */
export function isPresetCategory(name: string): boolean {
  return knownTagSet.has(categoryLookupKey(name))
}

function findColorForCategoryName(name: string): string {
  const key = categoryLookupKey(name)
  const active = findActiveTask()
  if (active) {
    const hit = findTagInTask(active, name)
    if (hit) return resolveTagColor(hit.group, hit.tag)
  }
  for (const task of state.tasks) {
    for (const g of task.groups) {
      const t = g.tags.find((x) => categoryLookupKey(x.name) === key)
      if (t) return resolveTagColor(g, t)
    }
  }
  return hashColor(name)
}

function withAlpha(hex: string, alpha: number): string {
  const c = normalizeColor(hex) || GROUP_COLOR.other
  const rgb = parseHexRgb(c)
  if (!rgb) return c
  if (alpha >= 1) return c
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
}

function mixToward(
  hex: string,
  target: { r: number; g: number; b: number },
  amount: number
): string {
  const c = normalizeColor(hex) || GROUP_COLOR.other
  const rgb = parseHexRgb(c)
  if (!rgb) return c
  const t = Math.min(1, Math.max(0, amount))
  const r = Math.round(rgb.r + (target.r - rgb.r) * t)
  const g = Math.round(rgb.g + (target.g - rgb.g) * t)
  const b = Math.round(rgb.b + (target.b - rgb.b) * t)
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

/** 与白色混合 → 奶色底 */
function mixWithWhite(hex: string, amount: number): string {
  return mixToward(hex, { r: 255, g: 255, b: 255 }, amount)
}

/** 略加深 → 柔和字色 */
function mixWithBlack(hex: string, amount: number): string {
  return mixToward(hex, { r: 0, g: 0, b: 0 }, amount)
}

function categoryColor(name: string, alpha = 1): string {
  return withAlpha(findColorForCategoryName(name), alpha)
}

/**
 * 标签与时间轴共用的颜色阴影。
 * - 默认：半透明底 + 同色描边/外发光
 * - compact：时间轴片段（更实、内描边）
 */
export function categoryShadeStyle(
  name: string,
  opts?: { selected?: boolean; compact?: boolean }
): {
  background: string
  boxShadow: string
  color: string
  borderColor: string
} {
  const selected = opts?.selected ?? false
  const compact = opts?.compact ?? false
  const solid = categoryColor(name, 1)
  if (compact) {
    // 时间轴片段：奶色底 + 同色描边，保持与标签芯片一致的奶奶风
    const bg = mixWithWhite(solid, selected ? 0.32 : 0.48)
    const border = mixWithWhite(solid, selected ? 0.12 : 0.28)
    const text = mixWithBlack(solid, selected ? 0.42 : 0.34)
    return {
      background: bg,
      borderColor: border,
      color: text,
      boxShadow: `inset 0 0 0 ${selected ? 3 : 2}px ${border}`
    }
  }
  const fill = categoryColor(name, selected ? 0.88 : 0.2)
  const glow = categoryColor(name, selected ? 0.5 : 0.3)
  const ring = categoryColor(name, selected ? 0.95 : 0.55)
  return {
    background: fill,
    borderColor: ring,
    color: selected ? '#fff' : solid,
    boxShadow: `0 0 0 1px ${ring}, 0 2px 10px ${glow}`
  }
}

/**
 * 芯片展示色：标签色优先，否则大类色。
 * 半透明淡底 + 柔和描边/字色（奶奶风）。
 */
export function resolveChipColors(
  groupColor: string,
  tagColor?: string | null,
  opts?: { selected?: boolean }
): { solid: string; bg: string; border: string; color: string } {
  const solid =
    normalizeColor(tagColor) || normalizeColor(groupColor) || GROUP_COLOR.other
  const selected = opts?.selected ?? false
  return {
    solid,
    bg: withAlpha(solid, selected ? 0.34 : 0.2),
    border: withAlpha(solid, selected ? 0.55 : 0.4),
    color: mixWithBlack(solid, selected ? 0.42 : 0.32)
  }
}
