import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  FEED_PATH,
  feedScript,
  normalizeFeed,
  renderFeed,
  seenToday,
  lookFeedOnce,
} from '../lib/douyinlook.js'

const FEED = {
  aweme_list: [
    { aweme_id: '7700000000000000001', desc: '原声版来了 美式真的很生气', author: { nickname: '小满' }, video: { duration: 18200 }, statistics: { digg_count: 28000 } },
    { aweme_id: '7700000000000000002', desc: '徒步第 300 天', author: { nickname: '卡尔' }, video: { duration: 60000 }, statistics: { digg_count: 800 } },
    { desc: '没有 id 的那条不该出现' },
  ],
}

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyfeed-'))
  return dir
}

function fakeTransport(payload, { startOk = true, evalFail = false } = {}) {
  return {
    state: { navigated: '', closed: false, calls: 0 },
    async start() { return startOk ? { ok: true } : { ok: false, why: '起不来' } },
    async navigate(url) { this.state.navigated = url; return { ok: true } },
    async evaluate(expr, opts) {
      this.state.calls += 1
      this.state.awaitPromise = opts?.awaitPromise
      if (evalFail) return { ok: false, why: '没回话' }
      return { ok: true, value: typeof payload === 'string' ? payload : JSON.stringify(payload) }
    },
    async close() { this.state.closed = true; return { ok: true } },
  }
}

const cfgOn = { channels: { douyin: { enabled: true, homeUrl: '' } }, browse: { douyin: { enabled: true, topN: 6 } } }
const cfgOff = { channels: { douyin: { enabled: false } }, browse: { douyin: { enabled: false } } }

test('normalizeFeed：只收有 id 的，字段齐全', () => {
  const items = normalizeFeed(FEED)
  assert.equal(items.length, 2)
  assert.equal(items[0].id, '7700000000000000001')
  assert.equal(items[0].author, '小满')
  assert.equal(items[0].duration, 18)
  assert.equal(items[0].likes, 28000)
})

test('normalizeFeed：不是 JSON 就当没拿到', () => {
  assert.deepEqual(normalizeFeed('<html>login</html>'), [])
  assert.deepEqual(normalizeFeed(''), [])
  assert.deepEqual(normalizeFeed({}), [])
})

test('renderFeed：一条一行，带作者/时长/赞', () => {
  const text = renderFeed(normalizeFeed(FEED))
  const lines = text.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /美式真的很生气/)
  assert.match(lines[0], /小满/)
  assert.match(lines[0], /18 秒/)
  assert.match(lines[0], /2\.8 万 赞/)
})

test('feedScript：带上条数与只读接口，且不拼签名', () => {
  const s = feedScript(4)
  assert.match(s, /tab\/feed/)
  assert.match(s, /count=4/)
  assert.match(s, /credentials:'include'/)
  assert.doesNotMatch(s, /X-Bogus|a_bogus/)
})

test('seenToday：只认当天的 dyfeed 记账', () => {
  const events = [
    { type: 'meta', text: 'dyfeed:2026-11-04 7700000000000000001' },
    { type: 'meta', text: 'dyfeed:2026-11-03 7700000000000000002' },
    { type: 'meta', text: 'looked:BV1xx411c7mD' },
  ]
  const got = seenToday(events, '2026-11-04')
  assert.equal(got.size, 1)
  assert.ok(got.has('7700000000000000001'))
})

test('开关都没开：不拉浏览器，直说没开', async () => {
  const r = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOff })
  assert.equal(r.ok, false)
  assert.match(r.note, /没开/)
})

test('翻到了：返回素材，并记住今天翻过哪几条', async () => {
  const root = tmpRoot()
  const t = fakeTransport(FEED)
  const r = await lookFeedOnce({ root, cfg: cfgOn, transport: t, waitMs: 0 })
  assert.equal(r.ok, true)
  assert.match(r.text, /徒步第 300 天/)
  assert.equal(t.state.navigated, 'https://www.douyin.com/?recommend=1')
  assert.equal(t.state.awaitPromise, true)
  assert.equal(t.state.closed, true)

  const lines = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n')
  const meta = lines.map((l) => JSON.parse(l)).find((e) => String(e.text).startsWith('dyfeed:'))
  assert.ok(meta, '应该记一条 dyfeed')
  assert.match(meta.text, /7700000000000000001/)
})

test('同一天再翻：翻到的都见过了，不重复端上来', async () => {
  const root = tmpRoot()
  await lookFeedOnce({ root, cfg: cfgOn, transport: fakeTransport(FEED), waitMs: 0 })
  const r = await lookFeedOnce({ root, cfg: cfgOn, transport: fakeTransport(FEED), waitMs: 0 })
  assert.equal(r.ok, false)
  assert.match(r.note, /看过/)
})

test('抖音没给数据：不瞎编，直说没给', async () => {
  const r = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOn, transport: fakeTransport('<html></html>'), waitMs: 0 })
  assert.equal(r.ok, false)
  assert.match(r.note, /没给/)
})

test('浏览器起不来 / 页面不回话：各有各的说法', async () => {
  const a = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOn, transport: fakeTransport(FEED, { startOk: false }), waitMs: 0 })
  assert.equal(a.ok, false)
  assert.match(a.note, /起不来/)

  const b = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOn, transport: fakeTransport(FEED, { evalFail: true }), waitMs: 0 })
  assert.equal(b.ok, false)
  assert.match(b.note, /没回话/)
})

test('注册的工具名与说明', async () => {
  const { registerDouyinLook } = await import('../lib/douyinlook.js')
  const regs = []
  const ctx = { tools: { register: (t) => { regs.push(t); return t } } }
  registerDouyinLook(ctx, { root: tmpRoot() })
  assert.equal(regs.length, 1)
  assert.equal(regs[0].name, 'douyin_look')
  assert.match(regs[0].description, /推荐流/)
  assert.match(regs[0].description, /没有画面/)
})
