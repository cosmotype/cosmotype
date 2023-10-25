import { $, Database } from '@minatojs/core'
import { expect } from 'chai'
import { setup } from './utils'

interface Foo {
  id: number
  value: number
}

interface Bar {
  id: number
  uid: number
  pid: number
  value: number
  s: string
  obj: {
    x: number
    y: string
    z: string
    o: {
      a: number
      b: string
    }
  }
  l: string[]
}

interface Tables {
  foo: Foo
  bar: Bar
}

function ExperimentalTests(database: Database<Tables>) {
  database.extend('foo', {
    id: 'unsigned',
    value: 'integer',
  })

  database.extend('bar', {
    id: 'unsigned',
    uid: 'unsigned',
    pid: 'unsigned',
    value: 'integer',
    obj: 'json',
    s: 'string',
    l: 'list',
  }, {
    autoInc: true,
  })

  before(async () => {

    database.extend('foo', {
      id: 'unsigned',
      value: 'integer',
    })

    await setup(database, 'foo', [
      { id: 1, value: 0 },
      { id: 2, value: 2 },
      { id: 3, value: 2 },
    ])

    await setup(database, 'bar', [
      { uid: 1, pid: 1, value: 0, obj: { x: 1, y: 'a', z: '1', o: { a: 1, b: '1' } }, s: '1', l: ['1', '2'] },
      { uid: 1, pid: 1, value: 1, obj: { x: 2, y: 'b', z: '2', o: { a: 2, b: '2' } }, s: '2' },
      { uid: 1, pid: 2, value: 0, obj: { x: 3, y: 'c', z: '3', o: { a: 3, b: '3' } }, s: '3' },
    ])
  })
}

namespace ExperimentalTests {
  export function computed(database: Database<Tables>) {
    // it('project', async () => {
    //   const res = await database.select('bar')
    //     .project({
    //       obj: row => (row.obj),
    //       objX: row => row.obj.x,
    //       objX2: row => $.add(row.obj.x, 2),
    //       objY: row => (row.obj.y),
    //     })
    //     // .orderBy(row => row.foo.id)
    //     .execute()
    //   console.log('res', res)
    // })

    it('$.object', async () => {
      const res = await database.select('foo')
        .project({
          obj: row => $.object({
            id: row.id,
            value: row.value,
          })
        })
        .orderBy(row => row.obj.id)
        .execute()

      expect(res).to.deep.equal([
        { obj: { id: 1, value: 0 } },
        { obj: { id: 2, value: 2 } },
        { obj: { id: 3, value: 2 } }
      ])
    })

    it('$.object in json', async () => {

      const res = await database.select('bar')
        .project({
          obj: row => $.object({
            num: row.obj.x,
            str: row.obj.y,
            str2: row.obj.z,
            obj: row.obj.o,
            a: row.obj.o.a,
          })
        })
        .execute()

      expect(res).to.deep.equal([
        { obj: { a: 1, num: 1, obj: { a: 1, b: "1" }, str: 'a', str2: '1' } },
        { obj: { a: 2, num: 2, obj: { a: 2, b: "2" }, str: 'b', str2: '2' } },
        { obj: { a: 3, num: 3, obj: { a: 3, b: "3" }, str: 'c', str2: '3' } }
      ])
    })

    it('$.array groupBy', async () => {
      const res = await database.join(['foo', 'bar'] as const, (foo, bar) => $.eq(foo.id, bar.pid))
        .groupBy(['foo'], {
          x: row => $.array(row.bar.obj.x),
          y: row => $.array(row.bar.obj.y),
        })
        .orderBy(row => row.foo.id)
        .execute()

      expect(res).to.deep.equal([
        { foo: { id: 1, value: 0 }, x: [1, 2], y: ['a', 'b'] },
        { foo: { id: 2, value: 2 }, x: [3], y: ['c'] }
      ])
    })

    it('$.array groupFull', async () => {
      const res = await database.select('bar')
        .project({
          count2: row => $.array(row.s),
          countnumber: row => $.array(row.value),
          x: row => $.array(row.obj.x),
          y: row => $.array(row.obj.y),
        })
        .execute()

      expect(res).to.deep.equal([
        {
          count2: ["1", "2", "3"],
          countnumber: [0, 1, 0],
          x: [1, 2, 3],
          y: ['a', 'b', 'c']
        }
      ])
    })

    it('$.array groupBy in json', async () => {
      const res = await database.join(['foo', 'bar'] as const, (foo, bar) => $.eq(foo.id, bar.pid))
        .groupBy('foo', {
          bars: row => $.array($.object({
            value: row.bar.value
          })),
          x: row => $.array(row.bar.obj.x),
          y: row => $.array(row.bar.obj.y),
          z: row => $.array(row.bar.obj.z),
          o: row => $.array(row.bar.obj.o),
        })
        .orderBy(row => row.foo.id)
        .execute()

      expect(res).to.deep.equal([
        {
          foo: { id: 1, value: 0 },
          bars: [{ value: 0 }, { value: 1 }],
          x: [1, 2],
          y: ['a', 'b'],
          z: ['1', '2'],
          o: [{ a: 1, b: '1' }, { a: 2, b: '2' }]
        },
        {
          foo: { id: 2, value: 2 },
          bars: [{ value: 0 }],
          x: [3],
          y: ['c'],
          z: ['3'],
          o: [{ a: 3, b: '3' }]
        }
      ])
    })
  }
}

export default ExperimentalTests