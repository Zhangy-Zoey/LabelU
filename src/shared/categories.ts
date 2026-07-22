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

/** 可手动扩展的三大行为类（不含「其他」） */
export type ExtensibleGroupId = 'normal' | 'abnormal' | 'danger'

const EXTENSIBLE_IDS: ExtensibleGroupId[] = ['normal', 'abnormal', 'danger']

const LS_CUSTOM_CATEGORIES = 'labelu.customCategoryTags'

/** 用户在各大类下手动添加的标签（内存；渲染进程会从 localStorage 加载） */
const customByGroup: Record<ExtensibleGroupId, string[]> = {
  normal: [],
  abnormal: [],
  danger: []
}

let knownTagSet = new Set(CATEGORY_GROUPS.flatMap((g) => g.tags))

function addTagVariants(set: Set<string>, tag: string): void {
  const t = tag.trim()
  if (!t) return
  set.add(t)
  // 与 sanitizeName 一致：目录名里 / 等会变成 _（如 蹦跳/跑酷 → 蹦跳_跑酷）
  const dirAlias = sanitizeName(t)
  if (dirAlias) set.add(dirAlias)
}

function rebuildKnownTagSet(): void {
  knownTagSet = new Set<string>()
  for (const g of CATEGORY_GROUPS) {
    for (const t of g.tags) addTagVariants(knownTagSet, t)
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
    danger: [...customByGroup.danger]
  }
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

/** 从 localStorage 加载自定义标签（仅渲染进程调用） */
export function loadCustomCategoryTags(): void {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(LS_CUSTOM_CATEGORIES)
    if (!raw) return
    applyCustomCategoryTags(JSON.parse(raw) as Partial<Record<ExtensibleGroupId, string[]>>)
  } catch {
    /* ignore */
  }
}

export function saveCustomCategoryTags(): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(LS_CUSTOM_CATEGORIES, JSON.stringify(getCustomCategoryTags()))
  } catch {
    /* ignore */
  }
}

export function getCategoryGroupsWithCustom(): CategoryGroup[] {
  return CATEGORY_GROUPS.map((g) => {
    if (!EXTENSIBLE_IDS.includes(g.id as ExtensibleGroupId)) return g
    const extras = customByGroup[g.id as ExtensibleGroupId]
    if (!extras.length) return g
    const tags = [...g.tags]
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
  if (knownTagSet.has(name)) return { ok: false, error: '该标签已存在' }
  customByGroup[groupId].push(name)
  rebuildKnownTagSet()
  return { ok: true, name }
}

/** 是否为内置预设标签（不可删除） */
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

export function tryRemoveCustomCategoryTag(
  rawName: string
): { ok: true; name: string; groupId: ExtensibleGroupId } | { ok: false; error: string } {
  const name = rawName.trim()
  if (!name) return { ok: false, error: '未选中标签' }
  if (isBuiltinCategoryTag(name)) return { ok: false, error: '预设标签不可删除' }
  const groupId = findCustomCategoryGroup(name)
  if (!groupId) return { ok: false, error: '只能删除手动添加的标签' }
  customByGroup[groupId] = customByGroup[groupId].filter((t) => t !== name)
  rebuildKnownTagSet()
  return { ok: true, name, groupId }
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

/** 预设或用户在三大类下手动添加的标签 */
export function isPresetCategory(name: string): boolean {
  return knownTagSet.has(name.trim())
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
