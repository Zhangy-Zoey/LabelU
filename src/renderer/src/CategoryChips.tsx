import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MAX_CUSTOM_TASKS,
  MORANDI_COLORS,
  addCategoryGroup,
  createCustomClassifyTask,
  deleteClassifyTask,
  getActiveClassifyTask,
  getActiveTaskGroups,
  getClassifyTasksPersistPayload,
  listClassifyTasks,
  nearestMorandiColor,
  removeCategoryGroup,
  renameClassifyTask,
  reorderCategoryGroups,
  reorderCategoryTags,
  resolveChipColors,
  restoreFactoryClassifyTasks,
  saveClassifyTasks,
  setActiveClassifyTask,
  tryAddCategoryTag,
  updateCategoryGroup,
  updateCategoryTag,
  type CategoryGroup,
  type ClassifyTask
} from '../../shared/categories'

type Props = {
  value: string
  onSelect: (tag: string) => void
  /** 传入当前标签，避免 Enter 确认时读到尚未更新的 value */
  onConfirm?: (tag?: string) => void
  /** 请求删除当前选中的标签（由外层弹窗确认） */
  onRequestDelete?: (tag: string) => void
  /** 外部增删后递增，强制刷新列表 */
  refreshKey?: number
}

type EditGroupState = { groupId: string; title: string; color: string }
type EditTagState = {
  tagId: string
  groupId: string
  name: string
  color: string
  inherit: boolean
}

function persistTasks(): void {
  saveClassifyTasks()
  void window.api.setClassifyTasks(getClassifyTasksPersistPayload())
}

function MorandiColorPicker({
  value,
  onChange,
  disabled
}: {
  value: string
  onChange: (color: string) => void
  disabled?: boolean
}) {
  const selected = nearestMorandiColor(value)
  return (
    <div className={`morandi-color-picker ${disabled ? 'disabled' : ''}`} role="listbox" aria-label="选择颜色（赤橙黄绿青蓝紫）">
      {MORANDI_COLORS.map((c) => {
        const active = selected === c
        return (
          <button
            key={c}
            type="button"
            role="option"
            aria-selected={active}
            disabled={disabled}
            className={`morandi-swatch ${active ? 'selected' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => onChange(c)}
          />
        )
      })}
    </div>
  )
}

/** 按任务切换的分类标签；支持任务/大类/标签的增删改与同层拖拽排序 */
export function CategoryChips({
  value,
  onSelect,
  onConfirm,
  onRequestDelete,
  refreshKey = 0
}: Props) {
  const selected = value.trim()
  const [revision, setRevision] = useState(0)
  const [addingGroupId, setAddingGroupId] = useState<string | null>(null)
  const [draftTag, setDraftTag] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [newGroupTitle, setNewGroupTitle] = useState('')
  const [newGroupColor, setNewGroupColor] = useState<string>(MORANDI_COLORS[1])
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [newTaskName, setNewTaskName] = useState('')
  const [renameTaskOpen, setRenameTaskOpen] = useState(false)
  const [renameTaskName, setRenameTaskName] = useState('')
  const [editGroup, setEditGroup] = useState<EditGroupState | null>(null)
  const [editTag, setEditTag] = useState<EditTagState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [dragGroupId, setDragGroupId] = useState<string | null>(null)
  const [dragTag, setDragTag] = useState<{ groupId: string; tagId: string } | null>(null)
  const groupDragMovedRef = useRef(false)
  const tagDragMovedRef = useRef(false)

  useEffect(() => {
    setRevision((n) => n + 1)
  }, [refreshKey])

  const bump = useCallback(() => {
    persistTasks()
    setRevision((n) => n + 1)
  }, [])

  /** 关闭未提交的编辑/新建表单（点空白或 Esc） */
  const dismissTransientEditors = useCallback(() => {
    setEditGroup(null)
    setEditTag(null)
    setNewTaskOpen(false)
    setRenameTaskOpen(false)
    setNewGroupOpen(false)
    setAddingGroupId(null)
    setDraftTag('')
    setAddError(null)
    setFormError(null)
  }, [])

  const editorOpen =
    !!editGroup ||
    !!editTag ||
    newTaskOpen ||
    renameTaskOpen ||
    newGroupOpen ||
    addingGroupId != null

  useEffect(() => {
    if (!editorOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Element)) return
      if (t.closest('[data-classify-editor]')) return
      dismissTransientEditors()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [editorOpen, dismissTransientEditors])

  const tasks = useMemo(() => listClassifyTasks(), [revision])
  const active = useMemo(() => getActiveClassifyTask(), [revision])
  const groups = useMemo(() => getActiveTaskGroups(), [revision])
  const customCount = useMemo(
    () => tasks.filter((t) => t.kind === 'custom').length,
    [tasks]
  )

  const selectTask = useCallback(
    (taskId: string) => {
      const r = setActiveClassifyTask(taskId)
      if (!r.ok) {
        setFormError(r.error)
        return
      }
      setEditGroup(null)
      setEditTag(null)
      setAddingGroupId(null)
      setFormError(null)
      bump()
      // 切换任务后，若当前选中标签不在新任务中则清空
      const nextGroups = getActiveTaskGroups()
      const stillVisible = nextGroups.some((g) => g.tags.some((t) => t.name === selected))
      if (selected && !stillVisible) onSelect('')
    },
    [bump, selected, onSelect]
  )

  const commitNewTask = useCallback(() => {
    const r = createCustomClassifyTask(newTaskName)
    if (!r.ok) {
      setFormError(r.error)
      return
    }
    setNewTaskOpen(false)
    setNewTaskName('')
    setFormError(null)
    bump()
    void window.api.opHistoryLog({
      kind: 'classifyTaskAdd',
      label: `新建分类任务「${r.task.name}」`,
      detail: { id: r.task.id, name: r.task.name }
    })
  }, [newTaskName, bump])

  const commitRenameTask = useCallback(() => {
    if (!active) return
    const r = renameClassifyTask(active.id, renameTaskName)
    if (!r.ok) {
      setFormError(r.error)
      return
    }
    setRenameTaskOpen(false)
    setFormError(null)
    bump()
    void window.api.opHistoryLog({
      kind: 'classifyTaskRename',
      label: `重命名分类任务「${r.name}」`,
      detail: { id: active.id, name: r.name }
    })
  }, [active, renameTaskName, bump])

  const removeTask = useCallback(() => {
    if (!active) return
    const name = active.name
    if (!window.confirm(`确定删除分类任务「${name}」？其下大类与标签将一并移除。`)) return
    const r = deleteClassifyTask(active.id)
    if (!r.ok) {
      setFormError(r.error)
      return
    }
    setRenameTaskOpen(false)
    setRenameTaskName('')
    setEditGroup(null)
    setEditTag(null)
    setAddingGroupId(null)
    setFormError(null)
    bump()
    const nextGroups = getActiveTaskGroups()
    const stillVisible = nextGroups.some((g) => g.tags.some((t) => t.name === selected))
    if (selected && !stillVisible) onSelect('')
    void window.api.opHistoryLog({
      kind: 'classifyTaskRemove',
      label: `删除分类任务「${name}」`,
      detail: { name }
    })
  }, [active, bump, selected, onSelect])

  const restoreFactories = useCallback(() => {
    if (
      !window.confirm(
        '将「猫」「狗」恢复为出厂大类与标签（已有同名任务会重置内容；缺失则补回）。是否继续？'
      )
    ) {
      return
    }
    const r = restoreFactoryClassifyTasks()
    setEditGroup(null)
    setEditTag(null)
    setAddingGroupId(null)
    setFormError(null)
    bump()
    const nextGroups = getActiveTaskGroups()
    const stillVisible = nextGroups.some((g) => g.tags.some((t) => t.name === selected))
    if (selected && !stillVisible) onSelect('')
    const parts: string[] = []
    if (r.added.length) parts.push(`补回 ${r.added.join('、')}`)
    if (r.reset.length) parts.push(`重置 ${r.reset.join('、')}`)
    void window.api.opHistoryLog({
      kind: 'classifyTaskRestore',
      label: `恢复出厂任务${parts.length ? `（${parts.join('；')}）` : ''}`,
      detail: r
    })
  }, [bump, selected, onSelect])

  const commitAddTag = useCallback(
    (groupId: string) => {
      const name = draftTag.trim()
      if (!name) {
        setAddingGroupId(null)
        setDraftTag('')
        setAddError(null)
        return
      }
      const result = tryAddCategoryTag(groupId, name)
      if (!result.ok) {
        setAddError(result.error)
        return
      }
      bump()
      void window.api.opHistoryLog({
        kind: 'categoryTagAdd',
        label: `添加标签「${result.name}」`,
        detail: { name: result.name, groupId }
      })
      setAddingGroupId(null)
      setDraftTag('')
      setAddError(null)
      onSelect(result.name)
    },
    [draftTag, onSelect, bump]
  )

  const commitNewGroup = useCallback(() => {
    const r = addCategoryGroup(newGroupTitle, newGroupColor)
    if (!r.ok) {
      setFormError(r.error)
      return
    }
    setNewGroupOpen(false)
    setNewGroupTitle('')
    setFormError(null)
    bump()
    void window.api.opHistoryLog({
      kind: 'categoryGroupAdd',
      label: `新增大类「${r.group.title}」`,
      detail: { id: r.group.id, title: r.group.title }
    })
  }, [newGroupTitle, newGroupColor, bump])

  const commitEditGroup = useCallback(() => {
    if (!editGroup) return
    const r = updateCategoryGroup(editGroup.groupId, {
      title: editGroup.title,
      color: editGroup.color
    })
    if (!r.ok) {
      setFormError(r.error)
      return
    }
    setEditGroup(null)
    setFormError(null)
    bump()
  }, [editGroup, bump])

  const commitEditTag = useCallback(() => {
    if (!editTag) return
    const prevName = groups
      .flatMap((g) => g.tags)
      .find((t) => t.id === editTag.tagId)?.name
    const r = updateCategoryTag(editTag.tagId, {
      name: editTag.name,
      color: editTag.inherit ? null : editTag.color
    })
    if (!r.ok) {
      setFormError(r.error)
      return
    }
    if (prevName && selected === prevName && r.name !== prevName) {
      onSelect(r.name)
    }
    setEditTag(null)
    setFormError(null)
    bump()
  }, [editTag, bump, groups, selected, onSelect])

  const requestDeleteSelected = useCallback(() => {
    if (!selected || !onRequestDelete) return
    onRequestDelete(selected)
  }, [selected, onRequestDelete])

  const onGroupDrop = useCallback(
    (targetGroupId: string) => {
      if (!dragGroupId || dragGroupId === targetGroupId) {
        setDragGroupId(null)
        return
      }
      const from = groups.findIndex((g) => g.id === dragGroupId)
      const to = groups.findIndex((g) => g.id === targetGroupId)
      if (from < 0 || to < 0) {
        setDragGroupId(null)
        return
      }
      const r = reorderCategoryGroups(from, to)
      setDragGroupId(null)
      if (!r.ok) return
      bump()
    },
    [dragGroupId, groups, bump]
  )

  const onTagDrop = useCallback(
    (groupId: string, targetTagId: string) => {
      if (!dragTag || dragTag.groupId !== groupId) {
        setDragTag(null)
        return
      }
      const g = groups.find((x) => x.id === groupId)
      if (!g) {
        setDragTag(null)
        return
      }
      const from = g.tags.findIndex((t) => t.id === dragTag.tagId)
      const to = g.tags.findIndex((t) => t.id === targetTagId)
      if (from < 0 || to < 0 || from === to) {
        setDragTag(null)
        return
      }
      const r = reorderCategoryTags(groupId, from, to)
      setDragTag(null)
      if (!r.ok) return
      bump()
    },
    [dragTag, groups, bump]
  )

  return (
    <div
      className="category-chip-groups"
      onKeyDown={(e) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return
        const t = e.target as HTMLElement
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
        if (!selected) return
        e.preventDefault()
        e.stopPropagation()
        requestDeleteSelected()
      }}
    >
      <div className="classify-task-bar">
        <div className="classify-task-tabs" role="tablist" aria-label="分类任务">
          {tasks.map((task: ClassifyTask) => {
            const activeTask = active?.id === task.id
            return (
              <button
                key={task.id}
                type="button"
                role="tab"
                aria-selected={activeTask}
                className={`classify-task-tab ${activeTask ? 'selected' : ''}`}
                onClick={() => selectTask(task.id)}
              >
                {task.name}
              </button>
            )
          })}
        </div>
        <div className="classify-task-actions">
          {!newTaskOpen && (
            <button
              type="button"
              className="classify-task-action"
              disabled={customCount >= MAX_CUSTOM_TASKS}
              title={
                customCount >= MAX_CUSTOM_TASKS
                  ? `自定义任务最多 ${MAX_CUSTOM_TASKS} 个`
                  : '新建自定义任务'
              }
              onClick={() => {
                setNewTaskOpen(true)
                setNewTaskName('')
                setFormError(null)
              }}
            >
              + 任务
            </button>
          )}
          <button
            type="button"
            className="classify-task-action"
            title="补回或重置出厂「猫」「狗」任务（大类/标签恢复默认）"
            onClick={restoreFactories}
          >
            恢复猫狗
          </button>
          {active && !renameTaskOpen && (
            <button
              type="button"
              className="classify-task-action"
              onClick={() => {
                setRenameTaskOpen(true)
                setRenameTaskName(active.name)
                setFormError(null)
              }}
            >
              重命名
            </button>
          )}
          {active && (
            <button
              type="button"
              className="classify-task-action danger"
              disabled={tasks.length <= 1}
              title={tasks.length <= 1 ? '至少保留一个任务' : `删除任务「${active.name}」`}
              onClick={removeTask}
            >
              删除任务
            </button>
          )}
        </div>
      </div>

      {newTaskOpen && (
        <div className="classify-inline-form" data-classify-editor>
          <input
            value={newTaskName}
            autoFocus
            maxLength={32}
            placeholder="自定义任务名"
            onChange={(e) => {
              setNewTaskName(e.target.value)
              setFormError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                commitNewTask()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                dismissTransientEditors()
              }
            }}
          />
          <button type="button" onClick={commitNewTask}>
            创建
          </button>
        </div>
      )}

      {renameTaskOpen && active && (
        <div className="classify-inline-form" data-classify-editor>
          <input
            value={renameTaskName}
            autoFocus
            maxLength={32}
            placeholder="任务名"
            onChange={(e) => {
              setRenameTaskName(e.target.value)
              setFormError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                commitRenameTask()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                dismissTransientEditors()
              }
            }}
          />
          <button type="button" onClick={commitRenameTask}>
            保存
          </button>
        </div>
      )}

      {groups.map((group: CategoryGroup) => {
        const isAdding = addingGroupId === group.id
        const editing = editGroup?.groupId === group.id
        /** 编辑大类颜色时即时预览（未保存）；点空白/Esc 取消则回到 group.color */
        const previewGroupColor =
          editing && editGroup ? editGroup.color : group.color
        return (
          <section key={group.id} className="category-chip-group">
            {editing && editGroup ? (
              <div className="classify-inline-form group-edit" data-classify-editor>
                <span
                  className="category-chip-group-swatch"
                  style={{ background: previewGroupColor }}
                  title="颜色预览"
                />
                <input
                  value={editGroup.title}
                  autoFocus
                  maxLength={32}
                  onChange={(e) =>
                    setEditGroup({ ...editGroup, title: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      e.stopPropagation()
                      commitEditGroup()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      dismissTransientEditors()
                    }
                  }}
                />
                <MorandiColorPicker
                  value={editGroup.color}
                  onChange={(color) => setEditGroup({ ...editGroup, color })}
                />
                <button type="button" onClick={commitEditGroup}>
                  保存
                </button>
                <button
                  type="button"
                  className="danger-text"
                  title="删除大类及其标签"
                  onClick={() => {
                    if (
                      !window.confirm(
                        `确定删除大类「${group.title}」？其下 ${group.tags.length} 个标签将一并移除。`
                      )
                    ) {
                      return
                    }
                    const removedNames = new Set(group.tags.map((t) => t.name))
                    const r = removeCategoryGroup(group.id)
                    if (!r.ok) {
                      setFormError(r.error)
                      return
                    }
                    if (selected && removedNames.has(selected)) onSelect('')
                    setEditGroup(null)
                    bump()
                  }}
                >
                  删除大类
                </button>
              </div>
            ) : (
              <header className="category-chip-group-title">
                <button
                  type="button"
                  className="category-chip-group-title-btn"
                  title="点击编辑大类名称与颜色；拖拽可调序"
                  draggable
                  onDragStart={() => {
                    groupDragMovedRef.current = false
                    setDragGroupId(group.id)
                  }}
                  onDrag={() => {
                    groupDragMovedRef.current = true
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onGroupDrop(group.id)}
                  onClick={() => {
                    if (groupDragMovedRef.current) {
                      groupDragMovedRef.current = false
                      return
                    }
                    setEditTag(null)
                    setEditGroup({
                      groupId: group.id,
                      title: group.title,
                      color: nearestMorandiColor(group.color)
                    })
                    setFormError(null)
                  }}
                >
                  <span
                    className="category-chip-group-swatch"
                    style={{ background: group.color }}
                  />
                  {group.title}
                </button>
              </header>
            )}

            <div className="category-chip-row">
              {group.tags.map((tag) => {
                const activeChip = selected === tag.name
                const colors = resolveChipColors(previewGroupColor, tag.color, {
                  selected: activeChip
                })
                const editingThis = editTag?.tagId === tag.id
                if (editingThis && editTag) {
                  return (
                    <span
                      key={tag.id}
                      className="category-chip-edit-form"
                      data-classify-editor
                    >
                      <input
                        className="category-chip-add-input"
                        value={editTag.name}
                        autoFocus
                        maxLength={32}
                        onChange={(e) =>
                          setEditTag({ ...editTag, name: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            e.stopPropagation()
                            commitEditTag()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            dismissTransientEditors()
                          }
                        }}
                      />
                      <label className="category-chip-inherit">
                        <input
                          type="checkbox"
                          checked={editTag.inherit}
                          onChange={(e) =>
                            setEditTag({
                              ...editTag,
                              inherit: e.target.checked,
                              color: e.target.checked
                                ? nearestMorandiColor(previewGroupColor)
                                : nearestMorandiColor(
                                    editTag.color || previewGroupColor
                                  )
                            })
                          }
                        />
                        继承大类色
                      </label>
                      {!editTag.inherit && (
                        <MorandiColorPicker
                          value={editTag.color}
                          onChange={(color) => setEditTag({ ...editTag, color })}
                        />
                      )}
                      <button type="button" onClick={commitEditTag}>
                        保存
                      </button>
                      <button
                        type="button"
                        className="danger-text"
                        onClick={() => {
                          setEditTag(null)
                          onRequestDelete?.(tag.name)
                        }}
                      >
                        删除
                      </button>
                    </span>
                  )
                }
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className={`category-chip ${activeChip ? 'selected' : ''}`}
                    aria-pressed={activeChip}
                    draggable
                    title={`${tag.name}（点选分类；再点一次编辑；拖拽调序；点空白/Esc 退出编辑）`}
                    style={{
                      background: colors.bg,
                      borderColor: colors.border,
                      color: colors.color
                    }}
                    onDragStart={(e) => {
                      e.stopPropagation()
                      tagDragMovedRef.current = false
                      setDragTag({ groupId: group.id, tagId: tag.id })
                    }}
                    onDrag={() => {
                      tagDragMovedRef.current = true
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onTagDrop(group.id, tag.id)
                    }}
                    onClick={() => {
                      if (tagDragMovedRef.current) {
                        tagDragMovedRef.current = false
                        return
                      }
                      if (activeChip) {
                        setEditGroup(null)
                        setEditTag({
                          tagId: tag.id,
                          groupId: group.id,
                          name: tag.name,
                          color: nearestMorandiColor(
                            tag.color?.trim() || previewGroupColor
                          ),
                          inherit: !tag.color?.trim()
                        })
                        setFormError(null)
                        return
                      }
                      onSelect(tag.name)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        e.stopPropagation()
                        onSelect(tag.name)
                        onConfirm?.(tag.name)
                        return
                      }
                      if ((e.key === 'Delete' || e.key === 'Backspace') && activeChip) {
                        e.preventDefault()
                        e.stopPropagation()
                        requestDeleteSelected()
                      }
                    }}
                  >
                    {tag.name}
                  </button>
                )
              })}
              {!isAdding && (
                <button
                  type="button"
                  className="category-chip category-chip-add"
                  style={(() => {
                    const addColors = resolveChipColors(previewGroupColor)
                    return {
                      borderColor: addColors.border,
                      color: addColors.color,
                      background: addColors.bg
                    }
                  })()}
                  title={`在「${group.title}」中新增标签`}
                  aria-label={`新增${group.title}标签`}
                  onClick={() => {
                    setAddingGroupId(group.id)
                    setDraftTag('')
                    setAddError(null)
                  }}
                >
                  +
                </button>
              )}
              {isAdding && (
                <span className="category-chip-add-form" data-classify-editor>
                  <input
                    className="category-chip-add-input"
                    value={draftTag}
                    autoFocus
                    placeholder="新标签名"
                    maxLength={32}
                    onChange={(e) => {
                      setDraftTag(e.target.value)
                      setAddError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        e.stopPropagation()
                        commitAddTag(group.id)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        e.stopPropagation()
                        dismissTransientEditors()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="category-chip category-chip-add-confirm"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitAddTag(group.id)}
                  >
                    添加
                  </button>
                </span>
              )}
            </div>
            {isAdding && addError && <p className="category-chip-add-error">{addError}</p>}
          </section>
        )
      })}

      {!newGroupOpen ? (
        <button
          type="button"
          className="classify-add-group"
          onClick={() => {
            setNewGroupOpen(true)
            setNewGroupTitle('')
            setNewGroupColor(MORANDI_COLORS[1])
            setFormError(null)
          }}
        >
          + 新增大类
        </button>
      ) : (
        <div className="classify-inline-form" data-classify-editor>
          <input
            value={newGroupTitle}
            autoFocus
            maxLength={32}
            placeholder="大类名称"
            onChange={(e) => {
              setNewGroupTitle(e.target.value)
              setFormError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                commitNewGroup()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                dismissTransientEditors()
              }
            }}
          />
          <MorandiColorPicker value={newGroupColor} onChange={setNewGroupColor} />
          <button type="button" onClick={commitNewGroup}>
            添加
          </button>
        </div>
      )}

      {formError && <p className="category-chip-add-error">{formError}</p>}
    </div>
  )
}
