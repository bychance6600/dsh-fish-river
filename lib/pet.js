/**
 * pet.js —— 让她能碰到 DSH 桌宠（dsh-pet）
 *
 * 只做三件事：看一眼、说一句、做个动作。
 *
 * 三条边界（都是"别把别人的模型混进来"）：
 *   1. **只投喂、不生成**：走 `/broadcast` 把**她自己说出来的字**搬上去；
 *      不用 `/whisper`（那是桌宠自己的模型写一句），否则气泡里会出现另一个她。
 *   2. **拿锁只拿几秒**：`/broadcast` 需要占用锁，持锁期间桌宠完全静止
 *      （它自己的碎碎念、余额、工作状态全让路）。所以说完立刻 release，
 *      不能让锁一直挂着。
 *   3. **永不抛、1.5 秒超时**：桌宠没装、没起来、被关掉，都只是「桌上没有那只」，
 *      渠道回话不受影响。
 *
 * 端口从哪来：桌宠挂在 DSH 自己的 web 服务上（`/dsh-pet-7340`），端口每次启动都变。
 * 我们插件也在同一个服务上，所以记下自己收到请求时的 `req.socket.localPort` 就够了
 * ——界面一打开就会有请求进来。取不到时退回上次成功过的端口 / 配置里的 `pet.baseUrl`。
 */

import fs from 'node:fs'
import path from 'node:path'
import { rootDir } from './store.js'
import { loadConfig } from './settings.js'
import { defineTool } from './tool.js'
import { toJsonSchema } from './toolschema.js'

export const PET_PREFIX = '/dsh-pet-7340'
export const PET_TIMEOUT_MS = 1500
export const PET_SAY_MS = 12000
export const PET_FILE = 'pet-port.json'

let cachedPort = 0

/** 记下我们自己被访问时的本地端口（＝ DSH web 服务的端口）。 */
export function notePetPort(req) {
  const p = Number(req?.socket?.localPort)
  if (Number.isFinite(p) && p > 1024 && p < 65536) cachedPort = p
}

/** 当前认为的端口（可能为 0）。 */
export function petPort() {
  return cachedPort
}

export function _setPetPort(p) {
  const n = Number(p)
  if (Number.isFinite(n) && n > 1024) cachedPort = n
}

export function _resetPetPort() {
  cachedPort = 0
}

export function rememberPort(root, port) {
  try {
    fs.writeFileSync(path.join(root, PET_FILE), JSON.stringify({ port: Number(port) || 0 }), 'utf8')
  } catch { /* 记不住就记不住，下次再探 */ }
}

export function readRememberedPort(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, PET_FILE), 'utf8'))
    const p = Number(j?.port)
    return Number.isFinite(p) && p > 1024 ? p : 0
  } catch { return 0 }
}

/** 基址：配置优先 → 本次进程见过的端口 → 上次成功的端口。 */
export async function petBase(root = rootDir(), cfg = null) {
  const config = cfg ?? (await loadConfig(root).catch(() => null))?.config
  const explicit = String(config?.pet?.baseUrl ?? '').trim()
  if (/^https?:\/\//.test(explicit)) return explicit.replace(/\/+$/, '')
  const port = cachedPort || readRememberedPort(root)
  if (!port) return ''
  return `http://127.0.0.1:${port}`
}

async function call(base, method, sub, { query = '', body = null } = {}) {
  if (!base) return { ok: false, why: '桌上没有那只（还不知道端口）' }
  const url = `${base}${PET_PREFIX}${sub}${query ? `?${query}` : ''}`
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(PET_TIMEOUT_MS),
    })
    const text = await res.text().catch(() => '')
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) return { ok: false, why: `桌上那只没应（HTTP ${res.status}）`, data, status: res.status }
    return { ok: true, data, status: res.status }
  } catch (err) {
    return { ok: false, why: `桌上没连上（${String(err?.message ?? err).slice(0, 60)}）` }
  }
}

/** 挑一只：优先 main，其次任意一只。 */
export function pickPet(state) {
  const pets = state?.pets ?? {}
  const names = Object.keys(pets)
  if (!names.length) return ''
  return names.includes('main') ? 'main' : names[0]
}

/** 读一眼：她在说什么、在干什么、余额多少。 */
export async function petState(root = rootDir()) {
  const base = await petBase(root)
  const r = await call(base, 'GET', '/state')
  if (!r.ok) return r
  const s = r.data ?? {}
  const pet = pickPet(s)
  const say = s?.pets?.[pet]?.say?.data?.text ?? ''
  const work = s?.sections?.workStatus?.data?.state ?? ''
  const balance = s?.sections?.balance?.data?.data?.wallets?.[0]
  const locked = Boolean(s?.pets?.[pet]?.lock?.data)
  return {
    ok: true,
    data: {
      pet,
      say: String(say).slice(0, 200),
      work: String(work),
      balance: balance ? `${balance.total} ${balance.currency}` : '',
      locked,
    },
  }
}

/** 把她说的话放上去（拿锁 → 投喂 → 立刻放锁）。 */
export async function petSay(root = rootDir(), text = '', { ms = PET_SAY_MS } = {}) {
  const body = String(text ?? '').trim().slice(0, 300)
  if (!body) return { ok: false, why: '没有话要放上去。' }
  const base = await petBase(root)
  const state = await petState(root)
  if (!state.ok) return state
  const pet = state.data.pet || 'main'
  const lock = await call(base, 'POST', '/lock', { query: `pet=${encodeURIComponent(pet)}` })
  if (!lock.ok) return lock
  const lockId = String(lock.data?.lockId ?? '')
  try {
    const sent = await call(base, 'POST', '/broadcast', {
      query: `pet=${encodeURIComponent(pet)}${lockId ? `&lock=${encodeURIComponent(lockId)}` : ''}`,
      body: { text: body, durationMs: ms },
    })
    if (!sent.ok) return sent
    return { ok: true, why: '' }
  } finally {
    if (lockId) {
      await call(base, 'POST', '/lock/release', {
        query: `pet=${encodeURIComponent(pet)}&lock=${encodeURIComponent(lockId)}`,
      }).catch(() => {})
    }
  }
}

/** 播一个动作（同样拿锁、立刻放）。 */
export async function petPlay(root = rootDir(), name = '') {
  const anim = String(name ?? '').trim()
  if (!anim) return { ok: false, why: '没说要播哪个动作。' }
  const base = await petBase(root)
  const state = await petState(root)
  if (!state.ok) return state
  const pet = state.data.pet || 'main'
  const lock = await call(base, 'POST', '/lock', { query: `pet=${encodeURIComponent(pet)}` })
  if (!lock.ok) return lock
  const lockId = String(lock.data?.lockId ?? '')
  try {
    const r = await call(base, 'POST', '/anim', {
      query: `pet=${encodeURIComponent(pet)}${lockId ? `&lock=${encodeURIComponent(lockId)}` : ''}`,
      body: { name: anim },
    })
    return r.ok ? { ok: true, why: '' } : r
  } finally {
    if (lockId) {
      await call(base, 'POST', '/lock/release', {
        query: `pet=${encodeURIComponent(pet)}&lock=${encodeURIComponent(lockId)}`,
      }).catch(() => {})
    }
  }
}

/** 三个工具。桌宠不在时它们只回一句「桌上没有那只」，不报错、不阻塞。 */
export function petTools(root = rootDir()) {
  return [
    {
      name: 'pet_state',
      description: '看一眼你桌上那只：它现在在说什么、在忙什么、余额还剩多少。只读。',
      parameters: { type: 'object', properties: {} },
      async run() {
        const r = await petState(root)
        if (!r.ok) return { text: r.why || '桌上没有那只。' }
        const d = r.data
        return {
          text: [
            d.say ? `它现在说的是：${d.say}` : '它现在没说话。',
            d.work ? `它在${d.work === 'working' ? '忙' : d.work}。` : '',
            d.balance ? `余额 ${d.balance}。` : '',
            d.locked ? '（它这会儿被别人占着，动不了。）' : '',
          ].filter(Boolean).join('\n'),
        }
      },
    },
    {
      name: 'pet_say',
      description: '把你说的一句话放到你桌上那只的气泡上（它不会自己再生成，只是把你写的字放上去）。一次最多 300 字。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', required: true, description: '要放上去的那句话。' } },
      },
      async run(args) {
        const r = await petSay(root, args?.text)
        return { text: r.ok ? '放到它嘴边了。' : (r.why || '没放上去。') }
      },
    },
    {
      name: 'pet_play',
      description: '让桌上那只播一个动作。动作名是它自己素材库里的名字；不知道名字就别猜，先看一眼状态。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', required: true, description: '动作名。' } },
      },
      async run(args) {
        const r = await petPlay(root, args?.name)
        return { text: r.ok ? '让它动了一下。' : (r.why || '它没动。') }
      },
    },
  ]
}

export function registerPet(ctx, { root = rootDir(), getConfig = null, log = () => {} } = {}) {
  const cfgOf = async () => (getConfig ? getConfig().catch(() => null) : (await loadConfig(root).catch(() => null))?.config)

  const defs = petTools(root)

  for (const d of defs) {
    const tool = defineTool({
      name: d.name,
      description: d.description,
      // 一定要过 toJsonSchema：属性里的 `required: true` 是 DSL，provider 只认根上的数组。
      // 2026-11-05 漏了这一步，provider 报 "true is not of type array"，她那一轮的所有工具都废掉。
      parameters: toJsonSchema(d.parameters),
      output: {
        schema: toJsonSchema({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }),
        render: (_a, out) => [{ type: 'text', text: String(out?.text ?? '') }],
      },
      async execute(args) {
        try {
          return await d.run(args ?? {})
        } catch (err) {
          log('pet · 失败', err?.message ?? err)
          return { text: '桌上那只没应。' }
        }
      },
    })
    ctx?.tools?.register?.(tool)
  }
}
