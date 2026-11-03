import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import { isOtherLanguageSubpage, resolveArchiveLanguageCode } from '../../app/utils/zim_language.js'

test('resolves single ISO 639-3 archive languages to ISO 639-1', () => {
  assert.equal(resolveArchiveLanguageCode('eng'), 'en')
  assert.equal(resolveArchiveLanguageCode(' FRA '), 'fr')
  assert.equal(resolveArchiveLanguageCode('ger'), 'de')
  assert.equal(resolveArchiveLanguageCode('en'), 'en')
})

test('disables filtering for multi-language, unknown or missing archive languages', () => {
  assert.equal(resolveArchiveLanguageCode('eng,fra'), null)
  assert.equal(resolveArchiveLanguageCode('eng, spa'), null)
  assert.equal(resolveArchiveLanguageCode('mul'), null)
  assert.equal(resolveArchiveLanguageCode('xho'), null)
  assert.equal(resolveArchiveLanguageCode('Unknown'), null)
  assert.equal(resolveArchiveLanguageCode(''), null)
  assert.equal(resolveArchiveLanguageCode(undefined), null)
})

/**
 * Regression for #1453: WikEM (Language `eng`) ships machine translations of
 * every article at `<Title>/<lang>`; ~96% of its entries are not English.
 */
test('skips WikEM translation subpages in an eng archive', () => {
  const en = resolveArchiveLanguageCode('eng')
  for (const path of [
    'Acetaminophen_Toxicity/pl',
    'Abd_pain/ja',
    'Abdominal_pain/es',
    'Abdominal_pain/de',
    'Abdominal_pain/fr',
    'Abdominal_pain/id',
    'Abciximab/ko',
    'Abciximab/vi',
    'Abciximab/zh',
    'Abciximab/pt-br',
    'Abciximab/zh-hans',
    'A/Abciximab/ru',
  ]) {
    assert.equal(isOtherLanguageSubpage(path, en), true, path)
  }
})

test('keeps the archive language, plain articles and English titles that end in two letters', () => {
  const en = resolveArchiveLanguageCode('eng')
  for (const path of [
    'Acetaminophen_toxicity',
    'Abciximab/en',
    'Abciximab/en-gb',
    'Vitamin/C',
    'Chemical_element/He',
    'Foo/It',
    'Foo/DE',
    'AC/DC',
    'TCP/IP',
    'Kg/ha',
    'Yes/no',
    'Mg/dl',
    'Abciximab/xx',
    'Abciximab/de-',
    'Abciximab/de-x',
    'Abciximab/deu',
    'de',
    '/de',
    'A//de',
  ]) {
    assert.equal(isOtherLanguageSubpage(path, en), false, path)
  }
})

test('filters relative to the archive language', () => {
  const fr = resolveArchiveLanguageCode('fra')
  assert.equal(isOtherLanguageSubpage('Paracétamol/fr', fr), false)
  assert.equal(isOtherLanguageSubpage('Paracétamol/en', fr), true)
})

test('never filters when the archive language did not resolve', () => {
  assert.equal(isOtherLanguageSubpage('Abciximab/de', null), false)
  assert.equal(isOtherLanguageSubpage('Abciximab/de', resolveArchiveLanguageCode('eng,deu')), false)
})

test('does not resolve Object prototype keys as languages', () => {
  assert.equal(resolveArchiveLanguageCode('constructor'), null)
  assert.equal(resolveArchiveLanguageCode('__proto__'), null)
})
