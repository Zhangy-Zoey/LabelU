import { sanitizeName } from './utils'

export type CategoryGroupId = 'normal' | 'abnormal' | 'danger' | 'other'

export type CategoryGroup = {
  id: CategoryGroupId
  title: string
  tags: string[]
}

/** 默认行为分类标签（平铺展示，非下拉） */
export const CATEGORY_GROUPS: CategoryGroup[] = [
  {
    id: 'normal',
    title: '正常行为',
    tags: [
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
    ]
  },
  {
    id: 'abnormal',
    title: '病理行为',
    tags: ['呕吐', '咳嗽', '打喷嚏', '抓挠/舔咬', '甩头', '擦肛', '跛行', '瘫痪', '抽搐']
  },
  {
    id: 'danger',
    title: '破坏性行为',
    tags: ['咬家具', '开门', '打架', '咬电线', '掏墙', '翻垃圾', '吃屎']
  },
  {
    id: 'other',
    title: '其他',
    tags: ['其他', '删除']
  }
]

/** 各大类均可手动扩展自定义标签 */
export type ExtensibleGroupId = CategoryGroupId

export const EXTENSIBLE_IDS: ExtensibleGroupId[] = ['normal', 'abnormal', 'danger', 'other']

const LS_CUSTOM_CATEGORIES = 'labelu.customCategoryTags'
const LS_REMOVED_BUILTINS = 'labelu.removedBuiltinCategoryTags'

/** 用户在各大类下手动添加的标签（内存；渲染进程会从 localStorage 加载） */
const customByGroup: Record<ExtensibleGroupId, string[]> = {
  normal: [],
  abnormal: [],
  danger: [],
  other: []
}

/** 用户删除的内置标签名（仅隐藏列表，不改已导出文件） */
const removedBuiltins = new Set<string>()

let knownTagSet = new Set(CATEGORY_GROUPS.flatMap((g) => g.tags))

/**
 * 标签查找键：统一小写。
 * Windows / 默认 macOS 卷均为大小写不敏感；避免目录「Run」与标签「run」对不上。
 */
function categoryLookupKey(name: string): string {
  return name.trim().toLowerCase()
}

function addTagVariants(set: Set<string>, tag: string): void {
  const t = tag.trim()
  if (!t) return
  set.add(categoryLookupKey(t))
  // 与 sanitizeName 一致：目录名里 / 等会变成 _（如 蹦跳/跑酷 → 蹦跳_跑酷）
  const dirAlias = sanitizeName(t)
  if (dirAlias) set.add(categoryLookupKey(dirAlias))
}

function rebuildKnownTagSet(): void {
  knownTagSet = new Set<string>()
  for (const g of CATEGORY_GROUPS) {
    for (const t of g.tags) {
      if (removedBuiltins.has(t)) continue
      addTagVariants(knownTagSet, t)
    }
  }
  for (const id of EXTENSIBLE_IDS) {
    for (const t of customByGroup[id]) addTagVariants(knownTagSet, t)
  }
}

// 初始化时纳入 sanitize 变体
rebuildKnownTagSet()

export function getCustomCategoryTags(): Record<ExtensibleGroupId, string[]> {
  return {
    normal: [...customByGroup.normal],
    abnormal: [...customByGroup.abnormal],
    danger: [...customByGroup.danger],
    other: [...customByGroup.other]
  }
}

export function getRemovedBuiltinTags(): string[] {
  return Array.from(removedBuiltins)
}

/** 持久化 / IPC 共用载荷：自定义标签 + 已删内置标签 */
export type CategoryTagsPersistPayload = Partial<Record<ExtensibleGroupId, string[]>> & {
  removedBuiltins?: string[]
}

export function getCategoryTagsPersistPayload(): CategoryTagsPersistPayload {
  return {
    ...getCustomCategoryTags(),
    removedBuiltins: getRemovedBuiltinTags()
  }
}

export function applyRemovedBuiltinTags(names: string[] | null | undefined): void {
  removedBuiltins.clear()
  if (Array.isArray(names)) {
    for (const n of names) {
      const t = String(n || '').trim()
      if (t) removedBuiltins.add(t)
    }
  }
  rebuildKnownTagSet()
}

/** 主/渲染进程共用：用完整 map 覆盖内存中的自定义标签 */
export function applyCustomCategoryTags(
  map: Partial<Record<ExtensibleGroupId, string[]>> | null | undefined
): void {
  for (const id of EXTENSIBLE_IDS) {
    const list = map?.[id]
    customByGroup[id] = Array.isArray(list)
      ? Array.from(new Set(list.map((t) => String(t).trim()).filter(Boolean)))
      : []
  }
  rebuildKnownTagSet()
}

/** 一次应用自定义 + 已删内置（磁盘 / IPC） */
export function applyCategoryTagsPersistPayload(
  map: CategoryTagsPersistPayload | null | undefined
): void {
  applyCustomCategoryTags(map)
  if (map && Array.isArray(map.removedBuiltins)) {
    applyRemovedBuiltinTags(map.removedBuiltins)
  }
}

/** 从 localStorage 加载自定义标签与已删内置（仅渲染进程调用） */
export function loadCustomCategoryTags(): void {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(LS_CUSTOM_CATEGORIES)
    if (raw) {
      applyCustomCategoryTags(JSON.parse(raw) as Partial<Record<ExtensibleGroupId, string[]>>)
    }
    const removedRaw = localStorage.getItem(LS_REMOVED_BUILTINS)
    if (removedRaw) {
      applyRemovedBuiltinTags(JSON.parse(removedRaw) as string[])
    }
  } catch {
    /* ignore */
  }
}

export function saveCustomCategoryTags(): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(LS_CUSTOM_CATEGORIES, JSON.stringify(getCustomCategoryTags()))
    localStorage.setItem(LS_REMOVED_BUILTINS, JSON.stringify(getRemovedBuiltinTags()))
  } catch {
    /* ignore */
  }
}

export function getCategoryGroupsWithCustom(): CategoryGroup[] {
  return CATEGORY_GROUPS.map((g) => {
    const base = g.tags.filter((t) => !removedBuiltins.has(t))
    const extras = customByGroup[g.id]
    if (!extras.length) return { ...g, tags: base }
    const tags = [...base]
    for (const t of extras) {
      if (!tags.includes(t)) tags.push(t)
    }
    return { ...g, tags }
  })
}

export function tryAddCustomCategoryTag(
  groupId: ExtensibleGroupId,
  rawName: string
): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = rawName.trim()
  if (!trimmed) return { ok: false, error: '请输入标签名' }
  if (trimmed === '.' || trimmed === '..' || /^\.+$/.test(trimmed)) {
    return { ok: false, error: '标签名无效' }
  }
  const name = sanitizeName(trimmed)
  if (!name || name === 'unnamed') return { ok: false, error: '标签名无效' }
  if (name.length > 32) return { ok: false, error: '标签名过长' }
  // 若曾删除同名内置标签，再添加时先从「已删内置」移除，恢复为内置展示
  if (removedBuiltins.has(name) && CATEGORY_GROUPS.some((g) => g.tags.includes(name))) {
    removedBuiltins.delete(name)
    rebuildKnownTagSet()
    return { ok: true, name }
  }
  if (knownTagSet.has(categoryLookupKey(name))) return { ok: false, error: '该标签已存在' }
  customByGroup[groupId].push(name)
  rebuildKnownTagSet()
  return { ok: true, name }
}

/** 是否为内置预设标签（原始列表，含已被用户隐藏的） */
export function isBuiltinCategoryTag(name: string): boolean {
  const key = name.trim()
  if (!key) return false
  return CATEGORY_GROUPS.some((g) => g.tags.includes(key))
}

/** 查找自定义标签所在分组 */
export function findCustomCategoryGroup(name: string): ExtensibleGroupId | null {
  const key = name.trim()
  if (!key) return null
  for (const id of EXTENSIBLE_IDS) {
    if (customByGroup[id].includes(key)) return id
  }
  return null
}

/** 当前可见标签所在分组（内置或自定义） */
export function findVisibleCategoryGroup(name: string): ExtensibleGroupId | null {
  const key = name.trim()
  if (!key) return null
  for (const g of getCategoryGroupsWithCustom()) {
    if (g.tags.includes(key)) return g.id
  }
  return null
}

/**
 * 删除标签（内置或自定义均可）。
 * 仅从标签列表移除；不改动已导出文件。
 */
export function tryRemoveCategoryTag(
  rawName: string
):
  | { ok: true; name: string; groupId: ExtensibleGroupId; source: 'custom' | 'builtin' }
  | { ok: false; error: string } {
  const name = rawName.trim()
  if (!name) return { ok: false, error: '未选中标签' }

  const customGroup = findCustomCategoryGroup(name)
  if (customGroup) {
    customByGroup[customGroup] = customByGroup[customGroup].filter((t) => t !== name)
    rebuildKnownTagSet()
    return { ok: true, name, groupId: customGroup, source: 'custom' }
  }

  const builtinGroup = CATEGORY_GROUPS.find((g) => g.tags.includes(name))
  if (builtinGroup) {
    if (removedBuiltins.has(name)) return { ok: false, error: '该标签已删除' }
    removedBuiltins.add(name)
    rebuildKnownTagSet()
    return { ok: true, name, groupId: builtinGroup.id, source: 'builtin' }
  }

  return { ok: false, error: '未找到该标签' }
}

const CATEGORY_PALETTE = [
  '#7ea9c3',
  '#7d9e84',
  '#b8a0c4',
  '#c4a574',
  '#c47d7f',
  '#8eb6cc',
  '#95b399',
  '#d4b88a',
  '#d4a0a8',
  '#7eb0b8'
]

/** 预设或用户手动添加的标签 */
export function isPresetCategory(name: string): boolean {
  return knownTagSet.has(categoryLookupKey(name))
}

function categoryGroupOf(name: string): CategoryGroupId | null {
  const key = name.trim()
  for (const g of getCategoryGroupsWithCustom()) {
    if (g.tags.includes(key)) return g.id
  }
  return null
}

/** 时间轴等场景：按行为组取色；自定义名回退哈希色 */
const CATEGORY_GROUP_COLORS: Record<CategoryGroupId, string> = {
  normal: '#7d9e84',
  abnormal: '#c47d7f',
  danger: '#d4a574',
  other: '#7ea9c3'
}

/** 按类别名取色：预设行为组用固定色，其余稳定哈希 */
function categoryColor(name: string, alpha = 1): string {
  const group = categoryGroupOf(name)
  let hex: string
  if (group) {
    hex = CATEGORY_GROUP_COLORS[group]
  } else {
    const key = name.trim() || 'unnamed'
    let h = 2166136261
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    hex = CATEGORY_PALETTE[Math.abs(h) % CATEGORY_PALETTE.length]
  }
  if (alpha >= 1) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
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
  const fill = categoryColor(name, selected ? (compact ? 0.72 : 0.88) : compact ? 0.42 : 0.2)
  const glow = categoryColor(name, selected ? 0.5 : 0.3)
  const ring = categoryColor(name, selected ? 0.95 : 0.55)
  return {
    background: fill,
    borderColor: ring,
    color: selected || compact ? '#fff' : solid,
    boxShadow: compact
      ? `inset 0 0 0 ${selected ? 3 : 2}px ${ring}, 0 0 12px ${glow}`
      : `0 0 0 1px ${ring}, 0 2px 10px ${glow}`
  }
}
