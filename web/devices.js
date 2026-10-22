// 设备令牌存储。配对一次后,Mac / iOS 用 Bearer token 访问,不再反复发送站长口令。
// 只存 token 的 SHA-256;明文 token 仅在配对响应里返回一次。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const FILE_NAME = 'devices.json'
const TOUCH_MS = 5 * 60 * 1000

function fileFor(dataDir) {
  return path.join(dataDir, FILE_NAME)
}

function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function readAll(dataDir) {
  try {
    const obj = JSON.parse(fs.readFileSync(fileFor(dataDir), 'utf8'))
    return Array.isArray(obj?.devices) ? obj.devices : []
  } catch {
    return []
  }
}

function writeAll(dataDir, devices) {
  const file = fileFor(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** 新建设备令牌,返回明文 token(只此一次)。 */
export function pairDevice(dataDir, name) {
  const id = crypto.randomBytes(6).toString('hex')
  const token = crypto.randomBytes(32).toString('hex')
  const now = new Date().toISOString()
  const devices = readAll(dataDir).filter((d) => d.hash !== hash(token))
  devices.push({
    id,
    name: String(name || '未命名设备').slice(0, 60),
    hash: hash(token),
    createdAt: now,
    lastSeenAt: now,
  })
  writeAll(dataDir, devices)
  return { deviceId: id, deviceToken: token }
}

/** 按明文 token 找设备;顺带低频更新 lastSeenAt。 */
export function findDevice(dataDir, token) {
  if (!token) return null
  const h = hash(token)
  const devices = readAll(dataDir)
  const device = devices.find((d) => d.hash === h)
  if (!device) return null
  const now = Date.now()
  const last = Date.parse(device.lastSeenAt || '') || 0
  if (now - last > TOUCH_MS) {
    device.lastSeenAt = new Date(now).toISOString()
    try {
      writeAll(dataDir, devices)
    } catch {
      /* 心跳失败不影响请求 */
    }
  }
  return { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt }
}

export function listDevices(dataDir) {
  return readAll(dataDir)
    .map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

export function revokeDevice(dataDir, id) {
  const devices = readAll(dataDir)
  const next = devices.filter((d) => d.id !== id)
  if (next.length === devices.length) return false
  writeAll(dataDir, next)
  return true
}

/** 时间常量比较,避免 owner token 被逐字节探测。 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  if (x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

