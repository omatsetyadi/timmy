import { expect, it } from 'vitest'
import { isRiskLevel } from './index'

it('isRiskLevel recognizes the three tiers', () => {
  expect(isRiskLevel('safe')).toBe(true)
  expect(isRiskLevel('confirm')).toBe(true)
  expect(isRiskLevel('blocked')).toBe(true)
  expect(isRiskLevel('nope')).toBe(false)
})
