import * as fs from 'node:fs'

const IMAGE_PATH_PATTERNS = [/\/tmp\/[^\s"'<>]+\.png/gi, /\/var\/[^\s"'<>]+\.png/gi]

export function candidateImagePaths(text: string): string[] {
  const paths: string[] = []
  for (const pattern of IMAGE_PATH_PATTERNS) {
    paths.push(...(text.match(pattern) ?? []))
  }
  return [...new Set(paths)]
}

export function existingImagePaths(text: string): string[] {
  return candidateImagePaths(text).filter((imagePath) => {
    try {
      return fs.statSync(imagePath).isFile()
    } catch {
      return false
    }
  })
}
