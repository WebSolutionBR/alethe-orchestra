import type { ReactNode } from 'react'

import css from './Attention.module.css'
import { useAttentionCount } from './useAttention'

/** The Orchestra button's icon with the count of what waits on the user. */
export function AttentionIcon({ children }: { children: ReactNode }) {
  const count = useAttentionCount()
  return (
    <span className={css.anchor}>
      {children}
      {count > 0 ? (
        <span className={css.badge} aria-hidden="true">
          {count > 9 ? '9+' : count}
        </span>
      ) : null}
    </span>
  )
}
