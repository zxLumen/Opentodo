// 密钥持久化回归:只写 OPENTODO_DATA_DIR(生产 /data 卷),原子落盘、权限 0600。
// 用临时目录隔离,绝不碰真实 web/data 或 /data。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-key-test-'))
process.env.OPENTODO_DATA_DIR = tmp
delete process.env.OPENTODO_CHAT_KEY
delete process.env.ZX_AI_APP_TOKEN

const { getApiKey, setApiKey } = await import('../settings.js')
const settingsURL = new URL('../settings.js', import.meta.url).href

test('setApiKey:写入 DATA_DIR、权限 0600、可覆盖且不留临时文件', () => {
  const file = path.join(tmp, 'chat.key')
  setApiKey('sk-opentodo-test-1')
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'sk-opentodo-test-1')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(getApiKey(), 'sk-opentodo-test-1')

  setApiKey('sk-opentodo-test-2')
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'sk-opentodo-test-2')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(
    fs.readdirSync(tmp).filter((f) => f.startsWith('chat.key.tmp.')),
    [],
  )
})

test('模拟进程/容器重启:新进程从同一个 DATA_DIR 读回密钥', () => {
  const file = path.join(tmp, 'chat.key')
  setApiKey('sk-opentodo-restart-ok')
  const code = `import(${JSON.stringify(settingsURL)}).then((m) => process.stdout.write(m.getApiKey()))`
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, OPENTODO_DATA_DIR: tmp },
    encoding: 'utf8',
  })
  assert.equal(out, 'sk-opentodo-restart-ok')
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'sk-opentodo-restart-ok')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('setApiKey(空):删除密钥文件', () => {
  const file = path.join(tmp, 'chat.key')
  setApiKey('')
  assert.equal(fs.existsSync(file), false)
  assert.equal(getApiKey(), '')
})
