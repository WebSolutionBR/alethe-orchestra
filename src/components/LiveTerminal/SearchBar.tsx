import { CaseSensitive, ChevronDown, ChevronUp, Regex, Search, X } from 'lucide-react'
import type { KeyboardEvent, RefObject } from 'react'

import { useT } from '../../lib/i18n'
import styles from './LiveTerminal.module.css'

export type SearchBarProps = {
  query: string
  caseSensitive: boolean
  regex: boolean
  /** 1-based position of the active match; 0 when there is none. */
  current: number
  total: number
  invalid: boolean
  inputRef: RefObject<HTMLInputElement>
  onQuery: (query: string) => void
  onToggleCase: () => void
  onToggleRegex: () => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}

export function SearchBar({
  query,
  caseSensitive,
  regex,
  current,
  total,
  invalid,
  inputRef,
  onQuery,
  onToggleCase,
  onToggleRegex,
  onNext,
  onPrevious,
  onClose,
}: SearchBarProps) {
  const t = useT()

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === 'F3') {
      event.preventDefault()
      if (event.shiftKey) onPrevious()
      else onNext()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      event.currentTarget.select()
    }
  }

  const status = invalid
    ? t('liveTerminal.search.invalid')
    : query && total === 0
      ? t('liveTerminal.search.none')
      : query
        ? t('liveTerminal.search.count', { current, total })
        : ''

  return (
    <div
      className={styles.search}
      role="search"
      aria-label={t('liveTerminal.search.label')}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Search size={13} className={styles.searchIcon} aria-hidden="true" />
      <input
        ref={inputRef}
        className={styles.searchInput}
        value={query}
        placeholder={t('liveTerminal.search.placeholder')}
        aria-label={t('liveTerminal.search.label')}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span
        className={`${styles.searchCount} ${invalid || (query && total === 0) ? styles.searchMiss : ''}`}
      >
        {status}
      </span>
      <button
        type="button"
        className={styles.searchToggle}
        aria-pressed={caseSensitive}
        title={t('liveTerminal.search.case')}
        aria-label={t('liveTerminal.search.case')}
        onClick={onToggleCase}
      >
        <CaseSensitive size={14} />
      </button>
      <button
        type="button"
        className={styles.searchToggle}
        aria-pressed={regex}
        title={t('liveTerminal.search.regex')}
        aria-label={t('liveTerminal.search.regex')}
        onClick={onToggleRegex}
      >
        <Regex size={14} />
      </button>
      <button
        type="button"
        className={styles.searchButton}
        title={t('liveTerminal.search.prev')}
        aria-label={t('liveTerminal.search.prev')}
        disabled={total === 0}
        onClick={onPrevious}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className={styles.searchButton}
        title={t('liveTerminal.search.next')}
        aria-label={t('liveTerminal.search.next')}
        disabled={total === 0}
        onClick={onNext}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className={styles.searchButton}
        title={t('liveTerminal.search.close')}
        aria-label={t('liveTerminal.search.close')}
        onClick={onClose}
      >
        <X size={14} />
      </button>
    </div>
  )
}
