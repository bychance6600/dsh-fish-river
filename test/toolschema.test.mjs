import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toJsonSchema } from '../lib/toolschema.js'

test('简写 DSL → 标准 JSON Schema：根节点必须是 type:object', () => {
  const out = toJsonSchema({
    what: { type: 'string', required: true, enum: ['home', 'search'], description: 'x' },
    keyword: { type: 'string', required: false, description: 'y' },
  })
  assert.equal(out.type, 'object')
  assert.deepEqual(Object.keys(out.properties), ['what', 'keyword'])
  assert.deepEqual(out.required, ['what'], 'required 必须提到根级数组')
  // 属性上不能再留 DSL 专有的 required，否则是非法 JSON Schema 词汇
  assert.equal(out.properties.what.required, undefined)
  assert.equal(out.properties.keyword.required, undefined)
  assert.deepEqual(out.properties.what.enum, ['home', 'search'])
})

test('没有必填项时不给空的 required 数组', () => {
  const out = toJsonSchema({ a: { type: 'string' } })
  assert.equal(out.required, undefined)
  assert.equal(out.type, 'object')
})

test('数组与嵌套对象里的 required 也要剥掉', () => {
  const out = toJsonSchema({
    refs: { type: 'array', required: false, items: { type: 'string', required: true } },
  })
  assert.equal(out.properties.refs.items.required, undefined)
  assert.equal(out.required, undefined, 'items 里的 required 不能冒到根级')
})

test('已是标准形态时幂等（重复包裹不坏）', () => {
  const once = toJsonSchema({ a: { type: 'string', required: true } })
  const twice = toJsonSchema(once)
  assert.deepEqual(twice, once)
})

test('空参数表也给出合法的 object schema', () => {
  assert.deepEqual(toJsonSchema({}), { type: 'object', properties: {}, additionalProperties: false })
})

// 2026-11-05 真机事故：pet_play 的参数写成
//   { type:'object', properties:{ name:{ type:'string', required:true } } }
// 上面那条「已是标准形态就原样返回」把它放行了，provider 报
//   Invalid schema for function 'pet_play': true is not of type "array"
// 一条坏 schema 会让那一轮所有工具调用一起失败。
const assertLegal = (schema) => {
  if (schema?.required !== undefined) assert.ok(Array.isArray(schema.required), '根上的 required 必须是数组')
  for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
    assert.equal(prop?.required, undefined, `属性 ${name} 里不许留 required:true`)
  }
}

test('写着根 type/properties 的「标准形态」也要把属性级 required 提到根上', () => {
  const out = toJsonSchema({
    type: 'object',
    properties: { name: { type: 'string', required: true, description: '动作名。' } },
  })
  assert.deepEqual(out.required, ['name'])
  assertLegal(out)
})

test('根上已有 required 数组时保留，不重复推', () => {
  const out = toJsonSchema({
    type: 'object',
    properties: { a: { type: 'string', required: true }, b: { type: 'string' } },
    required: ['a', 'b'],
  })
  assert.deepEqual(out.required, ['a', 'b'])
  assertLegal(out)
})
