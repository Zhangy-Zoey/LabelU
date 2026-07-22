import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type ExtensibleGroupId,
  findCustomCategoryGroup,
  getCategoryGroupsWithCustom,
  getCustomCategoryTags,
  isBuiltinCategoryTag,
  saveCustomCategoryTags,
  tryAddCustomCategoryTag
} from '../../shared/categories'

type Props = {
  value: string
  onSelect: (tag: string) => void
  /** 传入当前标签，避免 Enter 确认时读到尚未更新的 value */
  onConfirm?: (tag?: string) => void
  /** 请求删除当前选中的自定义标签（由外层弹窗确认） */
  onRequestDelete?: (tag: string) => void
  /** 外部增删标签后递增，强制刷新列表 */
  refreshKey?: number
}

const EXTENSIBLE = new Set<ExtensibleGroupId>(['normal', 'abnormal', 'danger'])

/** 预设 + 用户自定义标签；正常/异常/破坏三大类行末有「+」可手动添加 */
export function CategoryChips({ value, onSelect, onConfirm, onRequestDelete, refreshKey = 0 }: Props) {
  const selected = value.trim()
  const [revision, setRevision] = useState(0)
  const [addingGroup, setAddingGroup] = useState<ExtensibleGroupId | null>(null)
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  // App 启动时已同步自定义标签；此处仅用于弹窗打开后 / 外部删除后刷新展示
  useEffect(() => {
    setRevision((n) => n + 1)
  }, [refreshKey])

  const groups = useMemo(() => getCategoryGroupsWithCustom(), [revision])

  const commitAdd = useCallback(
    (groupId: ExtensibleGroupId) => {
      const name = draft.trim()
      if (!name) {
        setAddingGroup(null)
        setDraft('')
        setAddError(null)
        return
      }
      const result = tryAddCustomCategoryTag(groupId, name)
      if (!result.ok) {
        setAddError(result.error)
        return
      }
      saveCustomCategoryTags()
      void window.api.setCustomCategories(getCustomCategoryTags())
      setAddingGroup(null)
      setDraft('')
      setAddError(null)
      setRevision((n) => n + 1)
      onSelect(result.name)
    },
    [draft, onSelect]
  )

  const requestDeleteSelected = useCallback(() => {
    if (!selected || !onRequestDelete) return
    if (isBuiltinCategoryTag(selected)) return
    if (!findCustomCategoryGroup(selected)) return
    onRequestDelete(selected)
  }, [selected, onRequestDelete])

  return (
    <div
      className="category-chip-groups"
      onKeyDown={(e) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return
        const t = e.target as HTMLElement
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
        if (!selected) return
        e.preventDefault()
        e.stopPropagation()
        requestDeleteSelected()
      }}
    >
      {groups.map((group) => {
        const canExtend = EXTENSIBLE.has(group.id as ExtensibleGroupId)
        const groupId = group.id as ExtensibleGroupId
        const isAdding = addingGroup === groupId
        return (
          <section key={group.id} className={`category-chip-group ${group.id}`}>
            <header className="category-chip-group-title">{group.title}</header>
            <div className="category-chip-row">
              {group.tags.map((tag) => {
                const active = selected === tag
                const custom = Boolean(findCustomCategoryGroup(tag))
                return (
                  <button
                    key={tag}
                    type="button"
                    className={`category-chip ${active ? 'selected' : ''}`}
                    aria-pressed={active}
                    title={
                      custom
                        ? `${tag}（自定义 · 选中后按 Delete 删除）`
                        : tag
                    }
                    onClick={() => onSelect(tag)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        e.stopPropagation()
                        onSelect(tag)
                        onConfirm?.(tag)
                        return
                      }
                      if ((e.key === 'Delete' || e.key === 'Backspace') && active) {
                        e.preventDefault()
                        e.stopPropagation()
                        requestDeleteSelected()
                      }
                    }}
                  >
                    {tag}
                  </button>
                )
              })}
              {canExtend && !isAdding && (
                <button
                  type="button"
                  className="category-chip category-chip-add"
                  title={`在「${group.title}」中新增标签`}
                  aria-label={`新增${group.title}标签`}
                  onClick={() => {
                    setAddingGroup(groupId)
                    setDraft('')
                    setAddError(null)
                  }}
                >
                  +
                </button>
              )}
              {canExtend && isAdding && (
                <span className="category-chip-add-form">
                  <input
                    className="category-chip-add-input"
                    value={draft}
                    autoFocus
                    placeholder="新标签名"
                    maxLength={32}
                    onChange={(e) => {
                      setDraft(e.target.value)
                      setAddError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        e.stopPropagation()
                        commitAdd(groupId)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        e.stopPropagation()
                        setAddingGroup(null)
                        setDraft('')
                        setAddError(null)
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="category-chip category-chip-add-confirm"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitAdd(groupId)}
                  >
                    添加
                  </button>
                </span>
              )}
            </div>
            {canExtend && isAdding && addError && (
              <p className="category-chip-add-error">{addError}</p>
            )}
          </section>
        )
      })}
    </div>
  )
}
