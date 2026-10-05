import { describe, expect, it } from 'vitest'

import { addPaths, buildMessage, extensionOf, fileName, kindOf } from './attachments'

describe('composer attachments', () => {
  it('extracts file names and extensions from Windows and POSIX paths', () => {
    expect(fileName('C:\\Users\\me\\shot.PNG')).toBe('shot.PNG')
    expect(fileName('/tmp/dir/')).toBe('dir')
    expect(extensionOf('C:\\a\\shot.PNG')).toBe('png')
    expect(extensionOf('/home/.bashrc')).toBe('')
    expect(extensionOf('/home/Makefile')).toBe('')
  })

  it('classifies media kinds', () => {
    expect(kindOf('a.jpeg')).toBe('image')
    expect(kindOf('a.mp4')).toBe('video')
    expect(kindOf('a.wav')).toBe('audio')
    expect(kindOf('a.pdf')).toBe('pdf')
    expect(kindOf('a.tsx')).toBe('text')
    expect(kindOf('a.zip')).toBe('archive')
    expect(kindOf('a.bin')).toBe('file')
    expect(kindOf('noext')).toBe('file')
  })

  it('dedupes paths regardless of slashes and case and skips blanks', () => {
    const first = addPaths([], ['C:\\x\\a.png', '  '])
    const second = addPaths(first, ['c:/X/A.png', 'C:\\x\\b.txt'])
    expect(second.map((a) => a.name)).toEqual(['a.png', 'b.txt'])
    expect(second[0].kind).toBe('image')
  })

  it('builds the outgoing message with one path per line', () => {
    const atts = addPaths([], ['C:\\x\\a b.png', '/tmp/c.pdf'])
    expect(buildMessage('  hi  ', [], 'Files:')).toBe('hi')
    expect(buildMessage('hi', atts, 'Files:')).toBe('hi\n\nFiles:\n- C:\\x\\a b.png\n- /tmp/c.pdf')
    expect(buildMessage('', atts.slice(1), 'Files:')).toBe('Files:\n- /tmp/c.pdf')
  })
})
