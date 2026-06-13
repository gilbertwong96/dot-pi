import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'bun:test'

import { candidateImagePaths, existingImagePaths } from './images'

describe('critic image helpers', () => {
  test('extracts unique tmp and var png path candidates', () => {
    const text = '/tmp/a.png /tmp/a.png "/var/folders/capture.png" /tmp/not.txt'
    expect(candidateImagePaths(text)).toEqual(['/tmp/a.png', '/var/folders/capture.png'])
  })

  test('keeps only existing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'critic-images-'))
    const imagePath = join(dir, 'capture.png')
    writeFileSync(imagePath, '')

    expect(existingImagePaths(`${imagePath} /tmp/missing.png`)).toEqual([imagePath])
  })
})
