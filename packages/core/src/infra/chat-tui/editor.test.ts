import { describe, it, expect } from 'vitest'
import {
  emptyEditor,
  fromValue,
  insertText,
  insertNewline,
  backspace,
  moveLeft,
  moveRight,
  deleteWord,
  deleteToLineStart,
  moveUp,
  moveDown,
} from './editor'

describe('editor', () => {
  it('emptyEditor is empty with cursor 0', () => {
    expect(emptyEditor()).toEqual({ value: '', cursor: 0 })
  })
  it('fromValue puts the cursor at the end', () => {
    expect(fromValue('abc')).toEqual({ value: 'abc', cursor: 3 })
    expect(fromValue('')).toEqual({ value: '', cursor: 0 })
  })

  it('insertText inserts at the cursor (mid-string)', () => {
    expect(insertText({ value: 'ac', cursor: 1 }, 'b')).toEqual({ value: 'abc', cursor: 2 })
  })
  it('insertText appends at the end', () => {
    expect(insertText({ value: 'git', cursor: 3 }, ' commit')).toEqual({
      value: 'git commit',
      cursor: 10,
    })
  })
  it('insertNewline inserts a newline at the cursor', () => {
    expect(insertNewline({ value: 'ab', cursor: 1 })).toEqual({ value: 'a\nb', cursor: 2 })
  })

  it('backspace removes the char before the cursor (mid-string)', () => {
    expect(backspace({ value: 'abc', cursor: 2 })).toEqual({ value: 'ac', cursor: 1 })
  })
  it('backspace at cursor 0 is a no-op', () => {
    expect(backspace({ value: 'abc', cursor: 0 })).toEqual({ value: 'abc', cursor: 0 })
  })

  it('moveLeft decrements the cursor, clamped at 0', () => {
    expect(moveLeft({ value: 'abc', cursor: 2 })).toEqual({ value: 'abc', cursor: 1 })
    expect(moveLeft({ value: 'abc', cursor: 0 })).toEqual({ value: 'abc', cursor: 0 })
  })
  it('moveRight increments the cursor, clamped at length', () => {
    expect(moveRight({ value: 'abc', cursor: 1 })).toEqual({ value: 'abc', cursor: 2 })
    expect(moveRight({ value: 'abc', cursor: 3 })).toEqual({ value: 'abc', cursor: 3 })
  })

  it('deleteWord deletes the word before the cursor, preserving text after', () => {
    expect(deleteWord({ value: 'git commit -m', cursor: 13 })).toEqual({
      value: 'git commit ',
      cursor: 11,
    })
    // text AFTER the cursor preserved (value.slice(7)===' three')
    expect(deleteWord({ value: 'one two three', cursor: 7 })).toEqual({
      value: 'one  three',
      cursor: 4,
    })
  })
  it('deleteToLineStart deletes back to the current line start, preserving text after', () => {
    // before='a\nbc de' nl@1 keep='a\n'(2) after='f' => {value:'a\nf',cursor:2}
    expect(deleteToLineStart({ value: 'a\nbc def', cursor: 7 })).toEqual({
      value: 'a\nf',
      cursor: 2,
    })
    expect(deleteToLineStart({ value: 'hello world', cursor: 11 })).toEqual({
      value: '',
      cursor: 0,
    })
  })

  it('moveUp moves to the same column on the previous line', () => {
    // col 1 on line0 ('d' is col1 on line1 -> 'b' index1)
    expect(moveUp({ value: 'ab\ncd', cursor: 4 })).toEqual({ value: 'ab\ncd', cursor: 1 })
  })
  it('moveUp returns null on the first line', () => {
    expect(moveUp({ value: 'ab', cursor: 1 })).toBeNull()
  })
  it('moveUp clamps the column to the previous line length', () => {
    // value 'abc\nd', cursor 5 -> line1 col1; line0 len3 -> col min(1,3)=1 -> index1
    expect(moveUp({ value: 'abc\nd', cursor: 5 })).toEqual({ value: 'abc\nd', cursor: 1 })
    // cursor at end of a long line2 clamps to short line1
    // value 'a\nbcd', cursor 5 (col3 on line1) -> line0 len1 -> col min(3,1)=1 -> index1
    expect(moveUp({ value: 'a\nbcd', cursor: 5 })).toEqual({ value: 'a\nbcd', cursor: 1 })
  })
  it('moveDown moves to the same column on the next line', () => {
    // col1 line0 -> index 4 (col1 line1)
    expect(moveDown({ value: 'ab\ncd', cursor: 1 })).toEqual({ value: 'ab\ncd', cursor: 4 })
  })
  it('moveDown returns null on the last line', () => {
    expect(moveDown({ value: 'ab\ncd', cursor: 4 })).toBeNull()
    expect(moveDown({ value: 'ab', cursor: 1 })).toBeNull()
  })
  it('moveDown clamps the column to the next line length', () => {
    // value 'abc\nd', cursor 2 (col2 line0) -> line1 len1 -> col min(2,1)=1 -> base4+1=5
    expect(moveDown({ value: 'abc\nd', cursor: 2 })).toEqual({ value: 'abc\nd', cursor: 5 })
  })
})
