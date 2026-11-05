import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { _setPetPort, petSay, petState, petBase, notePetPort, pickPet } from '../lib/pet.js'

function root() { return fsx.mkdtempSync(path.join(os.tmpdir(), 'fish-pet-')) }
import fsx from 'node:fs'

function fakePet(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
    const u = String(url)
    if (u.endsWith('/state')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ pets: { main: { say: { data: { text: '在。' } }, lock: { data: null } } }, sections: { workStatus: { data: { state: 'idle' } }, balance: { data: { data: { wallets: [{ total: '6.80', currency: 'CNY' }] } } } } }) }
    }
    if (u.includes('/lock/release')) return { ok: true, status: 200, text: async () => '{"ok":true}' }
    if (u.includes('/lock')) return { ok: true, status: 200, text: async () => '{"lockId":"lk1","expiresAt":1}' }
    if (u.includes('/broadcast')) return { ok: true, status: 200, text: async () => '{"ok":true}' }
    if (u.includes('/anim')) return { ok: true, status: 200, text: async () => '{"ok":true}' }
    return { ok: false, status: 404, text: async () => '{}' }
  }
}

test('notePetPort：从请求里记下端口，基址随之变', async () => {
  _setPetPort(0)
  notePetPort({ socket: { localPort: 10292 } })
  const base = await petBase(fsx.mkdtempSync(path.join(os.tmpdir(), 'fish-pet0-')), {})
  assert.equal(base, 'http://127.0.0.1:10292')
})

test('petState：读出它在说什么、在忙什么、余额', async () => {
  _setPetPort(10292)
  const calls = []
  const old = globalThis.fetch
  globalThis.fetch = fakePet(calls)
  try {
    const r = await petState(root())
    assert.equal(r.ok, true)
    assert.equal(r.data.pet, 'main')
    assert.equal(r.data.say, '在。')
    assert.equal(r.data.balance, '6.80 CNY')
  } finally { globalThis.fetch = old }
})

test('petSay：拿锁 → 投喂她的话 → 立刻放锁', async () => {
  _setPetPort(10292)
  const calls = []
  const old = globalThis.fetch
  globalThis.fetch = fakePet(calls)
  try {
    const r = await petSay(root(), '我在这。', { ms: 5000 })
    assert.equal(r.ok, true)
    const order = calls.map((c) => c.method + ' ' + c.url.replace('http://127.0.0.1:10292', ''))
    assert.match(order[1], /POST \/dsh-pet-7340\/lock\?pet=main/)
    assert.match(order[2], /broadcast.*lock=lk1/)
    assert.equal(calls[2].body.text, '我在这。')
    assert.equal(calls[2].body.durationMs, 5000)
    assert.match(order[3], /lock\/release/)
  } finally { globalThis.fetch = old }
})

test('petSay：桌宠没起来时只说一句没连上，不抛', async () => {
  _setPetPort(10292)
  const old = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const r = await petSay(root(), '在。')
    assert.equal(r.ok, false)
    assert.match(r.why, /没连上/)
  } finally { globalThis.fetch = old }
})

test('pickPet：优先 main', () => {
  assert.equal(pickPet({ pets: { other: {}, main: {} } }), 'main')
  assert.equal(pickPet({ pets: { only: {} } }), 'only')
  assert.equal(pickPet({}), '')
})
