// web 侧自测(思考强度查表/校验 + 请求体)。运行:`npm test` 或 `node --test scripts/selftest.mjs`。
// 用临时 OPENTODO_DATA_DIR 隔离,绝不碰真实的 web/data/settings.json。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-web-test-'))
process.env.OPENTODO_DATA_DIR = tmp

const { effortValues, effortMapFor } = await import('../effort.js')
const { getSettings, saveSettings, allowedEfforts } = await import('../settings.js')
const { openAiRequestBody } = await import('../chat.js')

test('effortValues:已知模型给出档位(大小写不敏感)', () => {
  assert.deepEqual(effortValues('opencode-z', 'deepseek-v4.1-flash'), ['low', 'high', 'max'])
  assert.deepEqual(effortValues('opencode-z', 'GLM-5.3-Flash'), ['low', 'high', 'max'])
})

test('effortValues:未知模型/空 → []', () => {
  assert.deepEqual(effortValues('opencode-z', 'no-such-model-xyz'), [])
  assert.deepEqual(effortValues('opencode-z', ''), [])
})

test('effortMapFor:按 provider 出「模型→档位」', () => {
  const m = effortMapFor('opencode-z')
  assert.deepEqual(m['deepseek-v4.1-flash'], ['low', 'high', 'max'])
})

test('saveSettings:合法 effort 保留,非法清空', () => {
  saveSettings({ provider: 'opencode-z', model: 'deepseek-v4.1-flash', baseUrl: 'x', effort: 'high' })
  assert.equal(getSettings().effort, 'high')
  saveSettings({ effort: 'banana' })
  assert.equal(getSettings().effort, '')
})

test('saveSettings:换模型后不适配的 effort 自动清空', () => {
  saveSettings({ provider: 'opencode-z', model: 'glm-5.2', baseUrl: 'x', effort: 'high' })
  assert.equal(getSettings().effort, 'high')
  saveSettings({ model: 'kimi-k3' }) // kimi-k3 只有 max
  assert.equal(getSettings().effort, '')
})

test('effortOverrides:目录里没有的模型可手动补', () => {
  saveSettings({
    provider: 'opencode-z',
    model: 'my-custom-model',
    baseUrl: 'x',
    effort: '',
    effortOverrides: { 'opencode-z/my-custom-model': ['low', 'high'] },
  })
  assert.deepEqual(allowedEfforts(getSettings(), 'my-custom-model'), ['low', 'high'])
  saveSettings({ effort: 'low' })
  assert.equal(getSettings().effort, 'low')
})

test('openAiRequestBody:有 effort 才带 reasoning_effort', () => {
  const withEffort = openAiRequestBody({ model: 'm', temperature: 0.7, maxTokens: 100, effort: 'high', messages: [], useTools: false })
  assert.equal(withEffort.reasoning_effort, 'high')
  const without = openAiRequestBody({ model: 'm', temperature: 0.7, maxTokens: 100, effort: '', messages: [], useTools: false })
  assert.equal('reasoning_effort' in without, false)
})
