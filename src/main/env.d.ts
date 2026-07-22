/// <reference types="vite/client" />

declare module 'ffmpeg-static' {
  const path: string | null
  export default path
}

declare module 'ffprobe-static' {
  const ffprobe: { path: string }
  export default ffprobe
}
