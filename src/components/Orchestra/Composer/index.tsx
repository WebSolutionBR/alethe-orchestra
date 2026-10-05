import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import {
  ClipboardPaste,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  type LucideIcon,
  Paperclip,
  SendHorizontal,
  X,
} from 'lucide-react'
import { type ClipboardEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { type MessageKey, useT } from '../../../lib/i18n'
import { readClipboardPayload } from '../../../lib/tauri'
import { trapTab } from '../a11y/focusTrap'
import {
  addPaths,
  type AttachmentKind,
  buildMessage,
  type ComposerDraft,
  EMPTY_DRAFT,
  releaseDraft,
} from './attachments'
import styles from './Composer.module.css'

export type { Attachment, ComposerDraft } from './attachments'

export type ComposerTarget = {
  id: string
  /** Secondary label, e.g. the worker's area. */
  hint?: string
  /** False when the agent has no live terminal to paste into. */
  live: boolean
}

type ComposerProps = {
  targets: ComposerTarget[]
  target: string
  onTargetChange: (id: string) => void
  /** Controlled so the parent keeps the draft while the modal is closed. */
  draft: ComposerDraft
  onDraftChange: (draft: ComposerDraft) => void
  /** Receives the final text (message plus one attachment path per line). */
  onSend: (target: string, message: string) => Promise<void> | void
  onClose: () => void
  /** Attach the clipboard right after opening (files pasted somewhere else opened the composer). */
  pasteOnOpen?: { image?: Blob } | null
}

const KIND_ICON: Record<AttachmentKind, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  text: FileText,
  archive: FileArchive,
  file: File,
}

/**
 * Modal message composer, like the Claude Code prompt: large textarea, preview, images pasted from
 * the clipboard, files dropped on the window or picked from disk. Pasted images are written to a
 * temporary PNG by the backend and every attachment reaches the agent as an absolute path.
 */
export function Composer({
  targets,
  target,
  onTargetChange,
  draft,
  onDraftChange,
  onSend,
  onClose,
  pasteOnOpen,
}: ComposerProps) {
  const t = useT()
  const titleId = useId()
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [dragging, setDragging] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Async sources (clipboard, dialog, drag-drop) resolve after renders; always merge into the latest.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange
  const attach = (paths: string[], previewUrl?: string) => {
    const current = draftRef.current
    const next = { ...current, attachments: addPaths(current.attachments, paths, previewUrl) }
    draftRef.current = next
    onDraftChangeRef.current(next)
  }

  const current = targets.find((x) => x.id === target)
  const live = Boolean(current?.live)
  const message = buildMessage(
    draft.text,
    draft.attachments,
    t('orchestra.composer.attachmentsHeading'),
  )
  const canSend = live && message.length > 0 && !sending

  // Focus the textarea on open and give focus back to whatever had it on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    textRef.current?.focus()
    return () => previous?.focus?.()
  }, [])

  // Native drag-drop (Tauri hands over real paths). While the modal is open it owns every drop:
  // its backdrop covers the terminals, whose own listeners hit-test and ignore the event.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload
        if (p.type === 'enter' || p.type === 'over') setDragging(true)
        else if (p.type === 'leave') setDragging(false)
        else if (p.type === 'drop') {
          setDragging(false)
          if (p.paths.length > 0) attach(p.paths)
          textRef.current?.focus()
        }
      })
      .then((un) => {
        if (disposed) un()
        else unlisten = un
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
    // attach reads refs only.
     
  }, [])

  const insertText = (text: string) => {
    const el = textRef.current
    const value = draftRef.current.text
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const next = { ...draftRef.current, text: value.slice(0, start) + text + value.slice(end) }
    draftRef.current = next
    onDraftChangeRef.current(next)
    requestAnimationFrame(() => el?.setSelectionRange(start + text.length, start + text.length))
  }

  /** Reads files or an image from the OS clipboard; images become a temporary PNG on disk. */
  const pasteFromClipboard = async (imageBlob?: Blob) => {
    setError(null)
    try {
      const payload = await readClipboardPayload()
      switch (payload.kind) {
        case 'image':
          attach([payload.path], imageBlob ? URL.createObjectURL(imageBlob) : undefined)
          break
        case 'paths':
          attach(payload.paths)
          break
        case 'text':
          insertText(payload.text)
          break
        case 'empty':
          setError(t('orchestra.composer.clipboardEmpty'))
          break
      }
    } catch (err) {
      setError(t('orchestra.composer.pasteFailed', { message: String(err) }))
    }
  }

  const pastedOnOpen = useRef(false)
  useEffect(() => {
    if (!pasteOnOpen || pastedOnOpen.current) return
    pastedOnOpen.current = true
    void pasteFromClipboard(pasteOnOpen.image)
    // Runs once per mount; pasteFromClipboard only reads refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pasteOnOpen])

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return // plain text: the textarea handles it
    event.preventDefault()
    void pasteFromClipboard(files.find((f) => f.type.startsWith('image/')))
  }

  const pickFiles = async () => {
    setError(null)
    const picked = await openFileDialog({ multiple: true, directory: false }).catch(() => null)
    const paths = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : []
    if (paths.length > 0) attach(paths)
    textRef.current?.focus()
  }

  const remove = (id: string) => {
    const gone = draft.attachments.find((a) => a.id === id)
    if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
    onDraftChange({ ...draft, attachments: draft.attachments.filter((a) => a.id !== id) })
  }

  const send = async () => {
    if (!canSend) return
    setSending(true)
    setError(null)
    try {
      await onSend(target, message)
      releaseDraft(draft)
      onDraftChange(EMPTY_DRAFT)
      onClose()
    } catch (err) {
      setError(t('orchestra.composer.sendFailed', { message: String(err) }))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void send()
    } else if (event.key === 'Tab') {
      // Modal: Tab cycles inside the dialog instead of reaching the terminals behind it.
      trapTab(event.currentTarget, event)
    }
  }

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-dragging={dragging || undefined}
        onKeyDown={onKeyDown}
      >
        <header className={styles.head}>
          <span className={styles.mark} aria-hidden="true">
            ✻
          </span>
          <h2 id={titleId} className={styles.title}>
            {t('orchestra.composer.title')}
          </h2>
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            aria-label={t('orchestra.composer.close')}
            title={t('orchestra.composer.close')}
          >
            <X size={14} />
          </button>
        </header>

        <div className={styles.targets} role="radiogroup" aria-label={t('orchestra.composer.to')}>
          <span className={styles.label}>{t('orchestra.composer.to')}</span>
          {targets.map((x) => (
            <button
              key={x.id}
              type="button"
              role="radio"
              aria-checked={x.id === target}
              className={styles.target}
              data-live={x.live || undefined}
              title={x.live ? x.hint : t('orchestra.composer.offline', { id: x.id })}
              onClick={() => onTargetChange(x.id)}
            >
              <i aria-hidden="true" />
              {x.id}
              {x.hint ? <span className={styles.faint}>{x.hint}</span> : null}
            </button>
          ))}
        </div>

        <div className={styles.tabs} role="tablist">
          {(['write', 'preview'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={styles.tab}
              onClick={() => setTab(id)}
            >
              {t(`orchestra.composer.${id}` as MessageKey)}
            </button>
          ))}
          <span className={styles.spacer} />
          <button type="button" className={styles.btn} onClick={() => void pasteFromClipboard()}>
            <ClipboardPaste size={13} />
            {t('orchestra.composer.attachPaste')}
          </button>
          <button type="button" className={styles.btn} onClick={() => void pickFiles()}>
            <Paperclip size={13} />
            {t('orchestra.composer.attach')}
          </button>
        </div>

        <div className={styles.body}>
          {tab === 'write' ? (
            <textarea
              ref={textRef}
              className={styles.text}
              value={draft.text}
              spellCheck={false}
              placeholder={t('orchestra.composer.placeholder', { id: target })}
              onChange={(e) => onDraftChange({ ...draft, text: e.target.value })}
              onPaste={onPaste}
            />
          ) : (
            <pre className={styles.preview}>
              {message || (
                <span className={styles.faint}>{t('orchestra.composer.previewEmpty')}</span>
              )}
            </pre>
          )}
          {dragging ? (
            <div className={styles.drop} aria-hidden="true">
              <Paperclip size={18} />
              {t('orchestra.composer.dropHint')}
            </div>
          ) : null}
        </div>

        {draft.attachments.length > 0 ? (
          <ul
            className={styles.attachments}
            aria-label={t('orchestra.composer.attachmentsHeading')}
          >
            {draft.attachments.map((a) => {
              const Icon = KIND_ICON[a.kind]
              return (
                <li key={a.id} className={styles.att} title={a.path}>
                  {a.previewUrl ? (
                    <img className={styles.thumb} src={a.previewUrl} alt="" />
                  ) : (
                    <span className={styles.thumb} data-kind={a.kind}>
                      <Icon size={18} />
                    </span>
                  )}
                  <span className={styles.attText}>
                    <span className={styles.attName}>{a.name}</span>
                    <span className={styles.faint}>
                      {t(`orchestra.composer.kind.${a.kind}` as MessageKey)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => remove(a.id)}
                    aria-label={t('orchestra.composer.remove', { name: a.name })}
                    title={t('orchestra.composer.remove', { name: a.name })}
                  >
                    <X size={12} />
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <footer className={styles.foot}>
          <span className={styles.faint}>{t('orchestra.composer.hint')}</span>
          {draft.attachments.length > 0 ? (
            <span className={styles.faint}>
              · {t('orchestra.composer.attachmentsCount', { count: draft.attachments.length })}
            </span>
          ) : null}
          <span className={styles.spacer} />
          {!live ? (
            <span className={styles.warn}>{t('orchestra.composer.offline', { id: target })}</span>
          ) : null}
          <button
            type="button"
            className={styles.primary}
            disabled={!canSend}
            onClick={() => void send()}
          >
            <SendHorizontal size={13} />
            {sending ? t('orchestra.composer.sending') : t('orchestra.composer.send')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
