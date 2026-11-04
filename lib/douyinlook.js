/**
 * douyinlook.js —— 她自己的眼睛（抖音）：douyin_look 工具
 *
 * 为什么单独一个工具，而不是靠叫醒时端上来：
 *   她说过「没有能翻抖音的东西」——那句话是对的。叫醒时端上来的是**别人替她选的**，
 *   她想看的时候看不了。B 站那边有 bili_look，抖音这边也得有同一件事。
 *
 * 与 bili_look 的区别（也是这一版唯一的取巧处）：
 *   抖音网页版的推荐流在 DOM 里抓不到（标题画在 canvas 里），但站内只读接口
 *   `/aweme/v1/web/tab/feed/` 带着登录态就能读。所以这里借她自己的浏览器页面发一次
 *   fetch，拿 `desc` / 作者 / 时长 / 点赞。
 *   **只读**：不点赞、不评论、不关注；关浏览器时一并关掉。
 *
 * 三条与 bili_look 一致的约束：
 *   1. 只读，不留痕迹；
 *   2. 不回显状态（不说还剩几次、不说是第几阶段）；
 *   3. 不给她讲配置（不说"你被限制了"）。
 */

import path from 'node:path'
import { readEvents, rootDir, appendEvent } from './store.js'
import { loadConfig, dateKey } from './settings.js'
import { loadDouyin } from './douyinbrowse.js'
import { toJsonSchema } from './toolschema.js'
import { guardWrite } from './tenant.js'
import { defineTool } from './tool.js'

/** 站内只读推荐流（网页版 webapp 那一套参数；不带签名也能读，只要带 cookie）。 */
export const FEED_PATH = '/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&count='

export const FEED_MIN = 1
export const FEED_MAX = 8
export const FEED_HOME = 'https://www.douyin.com/?recommend=1'

/** 页面里跑的那一小段：读文本回来，不在页面里解析（解析留给 Node 侧，好测）。 */
export function feedScript(count = 6) {
  const n = Math.max(FEED_MIN, Math.min(24, Number(count) || 6))
  return `fetch('${FEED_PATH}${n}&refresh_index=1',{credentials:'include'}).then(function(r){return r.text()})`
}

/**
 * 把接口返回的那坨 JSON 变成她看得懂的几行。认不出就返回空数组，不瞎猜。
 * @param {string|object} raw
 * @returns {Array<{id:string,pick:string,desc:string,author:string,duration:number,likes:number}>}
 */
export function normalizeFeed(raw) {
  let data = raw
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { return [] }
  }
  const list = data?.aweme_list
  if (!Array.isArray(list)) return []
  const out = []
  for (const a of list) {
    const id = String(a?.aweme_id ?? '').trim()
    if (!/^\d{6,25}$/.test(id)) continue
    const desc = String(a?.desc ?? '').replace(/\s+/g, ' ').trim()
    const author = String(a?.author?.nickname ?? '').trim()
    const duration = Math.round(Number(a?.video?.duration ?? 0) / 1000) || 0
    const likes = Number(a?.statistics?.digg_count ?? 0) || 0
    out.push({ id, desc: desc || '（没有文案）', author, duration, likes })
  }
  return out
}

/** 几行素材，不带任何"你应该…"的口气。 */
export function renderFeed(items = []) {
  return items.map((it, i) => {
    const bits = [it.desc]
    if (it.author) bits.push(`作者 ${it.author}`)
    if (it.duration) bits.push(`${it.duration} 秒`)
    if (it.likes) bits.push(`${it.likes >= 10000 ? `${(it.likes / 10000).toFixed(1)} 万` : it.likes} 赞`)
    return `${i + 1}. ${bits.join(' · ')}`
  }).join('\n')
}

/** 今天已经翻到过的 id（同一天不重复端上来）。 */
export function seenToday(events, dk = dateKey()) {
  const set = new Set()
  for (const e of events ?? []) {
    const t = String(e?.text ?? '')
    if (e?.type !== 'meta' || !t.startsWith(`dyfeed:${dk}`)) continue
    for (const id of t.split(/\s+/).slice(1)) if (/^\d{6,25}$/.test(id)) set.add(id)
  }
  return set
}

/**
 * 翻一次。永不抛。
 * @param {object} o
 * @param {string} [o.root]
 * @param {object} [o.cfg]
 * @param {number} [o.limit]
 * @param {object} [o.transport] 测试注入
 * @param {number} [o.waitMs] 页面起来后等多久（测试传 0）
 * @returns {Promise<{ok:boolean,text:string,note:string,picks:object[]}>}
 */
export async function lookFeedOnce(o = {}) {
  const root = o.root ?? rootDir()
  let transport = o.transport ?? null
  try {
    const cfg = o.cfg ?? (await loadConfig(root)).config
    const want = Math.max(FEED_MIN, Math.min(FEED_MAX, Number(o.limit ?? cfg?.browse?.douyin?.topN ?? 6)))
    const browserPath = cfg?.browse?.douyin?.browserPath || cfg?.channels?.douyin?.browserPath || ''

    if (!cfg?.channels?.douyin?.enabled && !cfg?.browse?.douyin?.enabled) {
      return { ok: false, text: '', note: '抖音这边没开。', picks: [] }
    }

    if (!transport) {
      const mod = await loadDouyin()
      if (!mod?.createCdpTransport) {
        return { ok: false, text: '', note: '抖音那边没装。', picks: [] }
      }
      transport = await mod.createCdpTransport({
        browserPath,
        // 登录态在数据目录里那一个 profile 上（和私信渠道共用）
        profileDir: path.join(root, 'douyin-profile'),
      })
    }

    const started = await transport?.start?.()
    if (started && started.ok === false) {
      return { ok: false, text: '', note: started.why ?? '浏览器没起来。', picks: [] }
    }

    let raw = ''
    try {
      await transport.navigate?.(cfg?.channels?.douyin?.homeUrl || FEED_HOME)
      const wait = Number(o.waitMs ?? 1500)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      const got = await transport.evaluate?.(feedScript(want), { awaitPromise: true })
      if (got && got.ok === false) {
        return { ok: false, text: '', note: '抖音那边没回话。', picks: [] }
      }
      raw = typeof got === 'string' ? got : (got?.value ?? '')
    } finally {
      await transport?.close?.().catch?.(() => {})
    }

    const items = normalizeFeed(raw)
    if (!items.length) return { ok: false, text: '', note: '平台这会儿没给。', picks: [] }

    const events = o.events ?? (await readEvents(root).then((r) => r.events).catch(() => []))
    const dk = dateKey()
    const seen = seenToday(events, dk)
    const fresh = items.filter((it) => !seen.has(it.id)).slice(0, want)
    if (!fresh.length) {
      return { ok: false, text: '', note: '翻到的都看过了。想看哪条，把链接给我。', picks: [] }
    }

    const day = Number(o.model?.day ?? 0)
    const stage = Number(o.model?.stage ?? 1)
    await appendEvent(
      { type: 'meta', text: `dyfeed:${dk} ${fresh.map((it) => it.id).join(' ')}` },
      { day, stage, source: 'system' },
      root,
    ).catch(() => {})

    return {
      ok: true,
      text: renderFeed(fresh),
      note: '',
      picks: fresh.map((it) => ({ bvid: `dy_${it.id}`, title: it.desc, up: it.author, duration: it.duration, view: it.likes })),
    }
  } catch (err) {
    return { ok: false, text: '', note: String(err?.message ?? err).slice(0, 120), picks: [] }
  }
}

function tenancyOf(root, tenancy) {
  if (tenancy && typeof tenancy === 'object') {
    return { root, herDir: String(tenancy.herDir ?? ''), tenant: tenancy.tenant ?? { ok: true } }
  }
  return { root, herDir: '', tenant: { ok: true } }
}

/**
 * 注册工具。
 * @param {object} ctx
 * @param {{root?:string, transport?:object, waitMs?:number, tenant?:object}} deps
 */
export function registerDouyinLook(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  return ctx.tools.register(
    defineTool({
      name: 'douyin_look',
      description:
        '去抖音翻一眼推荐流：给的是文案、作者、时长、点赞数。只读，不点赞不评论。' +
        '这里没有画面——想知道一条里到底拍了什么，让他把链接发过来。' +
        '不用它也可以。',
      parameters: toJsonSchema({
        limit: { type: 'number', required: false, description: '翻几条，默认 6。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '翻到的几条' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) =>
          out.ok
            ? [{ type: 'text', text: `${out.text}\n\n（翻完了。想说就说，不想说也行。）` }]
            : [{ type: 'text', text: `这次没翻到什么：${out.note}` }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancyOf(root, deps.tenant), exec, 'douyin_look')
        if (!who.ok) return { ok: false, text: '', note: who.note }

        const { config } = await loadConfig(root)
        const r = await lookFeedOnce({
          root,
          cfg: config,
          limit: args?.limit,
          transport: deps.transport,
          waitMs: deps.waitMs,
        })
        return { ok: r.ok, text: r.text, note: r.note }
      },
    }),
  )
}
