import type { LabeluApi } from '../../shared/labeluApi'

declare global {
  interface Window {
    api: LabeluApi
  }
}

declare module '*.png' {
  const src: string
  export default src
}

export {}
