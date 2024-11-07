import { $, Database } from 'minato'
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

interface Baz {
  id: number
  nums: number[]
}

interface Bax {
  id: number
  array: {
    text: string
  }[]
  object: {
    num: number
  }
}

interface Tables {
  foo: Foo
  bar: Bar
  baz: Baz
  bax: Bax
}

function JsonTests(database: Database<Tables>) {
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

  database.extend('baz', {
    id: 'unsigned',
    nums: {
      type: 'array',
      inner: 'unsigned',
    }
  })

  database.extend('bax', {
    id: 'unsigned',
    array: {
      type: 'array',
      inner: {
        type: 'object',
        inner: {
          text: 'string',
        },
      },
    },
    object: {
      type: 'object',
      inner: {
        num: 'unsigned',
      },
    },
  })

  before(async () => {
    await setup(database, 'foo', [
      { id: 1, value: 0 },
      { id: 2, value: 2 },
      { id: 3, value: 2 },
    ])

    await setup(database, 'bar', [
      { uid: 1, pid: 1, value: 0, obj: { x: 1, y: 'a', z: '1', o: { a: 1, b: '1' } }, s: '1', l: ['1', '2'] },
      { uid: 1, pid: 1, value: 1, obj: { x: 2, y: 'b', z: '2', o: { a: 2, b: '2' } }, s: '2', l: ['5', '3', '4'] },
      { uid: 1, pid: 2, value: 0, obj: { x: 3, y: 'c', z: '3', o: { a: 3, b: '3' } }, s: '3', l: ['2'] },
    ])

    await setup(database, 'baz', [
      { id: 1, nums: [4, 5, 6] },
      { id: 2, nums: [5, 6, 7] },
      { id: 3, nums: [7, 8] },
    ])
  })
}

namespace JsonTests {
  const Bax = [{
    id: 1,
    array: [{ text: 'foo' }],
  }]

  export interface RelationOptions {
    nullableComparator?: boolean
  }

  export function query(database: Database<Tables>, options: RelationOptions = {}) {
    const { nullableComparator = true } = options

    it('$size', async () => {
      await expect(database.get('baz', {
        nums: { $size: 3 },
      })).to.eventually.deep.equal([
        { id: 1, nums: [4, 5, 6] },
        { id: 2, nums: [5, 6, 7] },
      ])

      await expect(database.select('baz', {
        nums: { $size: 3 },
      }).project({
        size: row => $.length(row.nums),
      }).execute()).to.eventually.deep.equal([
        { size: 3 },
        { size: 3 },
      ])

      await expect(database.select('baz', {
        nums: { $size: 0 },
      }).project({
        size: row => $.length(row.nums),
      }).execute()).to.eventually.have.length(0)
    })

    it('$el', async () => {
      await expect(database.get('baz', {
        nums: { $el: 5 },
      })).to.eventually.deep.equal([
        { id: 1, nums: [4, 5, 6] },
        { id: 2, nums: [5, 6, 7] },
      ])
    })

    it('$in', async () => {
      await expect(database.get('baz', row => $.in($.add(3, row.id), row.nums)))
        .to.eventually.deep.equal([
          { id: 1, nums: [4, 5, 6] },
          { id: 2, nums: [5, 6, 7] },
        ])
    })

    it('$nin', async () => {
      await expect(database.get('baz', row => $.nin($.add(3, row.id), row.nums)))
        .to.eventually.deep.equal([
          { id: 3, nums: [7, 8] },
        ])
    })

    it('execute nested selection', async () => {
      await expect(database.eval('bar', row => $.max($.add(1, row.value)))).to.eventually.deep.equal(2)
      await expect(database.eval('bar', row => $.max($.add(1, row.obj.x)))).to.eventually.deep.equal(4)
    })

    it('$get array', async () => {
      await expect(database.get('baz', row => $.eq($.get(row.nums, 0), 4)))
        .to.eventually.deep.equal([
          { id: 1, nums: [4, 5, 6] },
        ])

      await expect(database.get('baz', row => $.eq(row.nums[0], 4)))
        .to.eventually.deep.equal([
          { id: 1, nums: [4, 5, 6] },
        ])
    })

    nullableComparator && it('$get array with expressions', async () => {
      await expect(database.get('baz', row => $.eq($.get(row.nums, $.add(row.id, -1)), 4)))
        .to.eventually.deep.equal([
          { id: 1, nums: [4, 5, 6] },
        ])
    })

    it('$get object', async () => {
      await expect(database.get('bar', row => $.eq(row.obj.o.a, 2)))
        .to.eventually.have.shape([
          { value: 1 },
        ])

      await expect(database.get('bar', row => $.eq($.get(row.obj.o, 'a'), 2)))
        .to.eventually.have.shape([
          { value: 1 },
        ])
    })
  }

  export function modify(database: Database<Tables>) {
    it('$.object', async () => {
      await setup(database, 'bax', Bax)
      await database.set('bax', 1, row => ({
        object: $.object({
          num: row.id,
        }),
      }))
      await expect(database.get('bax', 1)).to.eventually.deep.equal([
        { id: 1, array: [{ text: 'foo' }], object: { num: 1 } },
      ])
    })

    it('$.literal', async () => {
      await setup(database, 'bax', Bax)

      await database.set('bax', 1, {
        array: $.literal([{ text: 'foo2' }]),
      })
      await expect(database.get('bax', 1)).to.eventually.deep.equal([
        { id: 1, array: [{ text: 'foo2' }], object: { num: 0 } },
      ])

      await database.set('bax', 1, {
        object: $.literal({ num: 2 }),
      })
      await expect(database.get('bax', 1)).to.eventually.deep.equal([
        { id: 1, array: [{ text: 'foo2' }], object: { num: 2 } },
      ])

      await database.set('bax', 1, {
        'object.num': $.literal(3),
      })
      await expect(database.get('bax', 1)).to.eventually.deep.equal([
        { id: 1, array: [{ text: 'foo2' }], object: { num: 3 } },
      ])
    })

    it('$.literal cast', async () => {
      await setup(database, 'bax', Bax)

      await database.set('bax', 1, {
        array: $.literal([{ text: 'foo2' }], 'array'),
      })
      await expect(database.get('bax', 1)).to.eventually.deep.equal([
        { id: 1, array: [{ text: 'foo2' }], object: { num: 0 } },
      ])

      await database.set('bax', 1, {
        object: $.literal({ num: 2 }, 'object'),
      })
      await expect(database.get('bax', 1)).to.eventually.deep.equal([
        { id: 1, array: [{ text: 'foo2' }], object: { num: 2 } },
      ])
    })

    it('nested illegal string', async () => {
      await setup(database, 'bax', Bax)
      await database.set('bax', 1, row => ({
        array: [{ text: '$foo2' }],
      }))
      await expect(database.get('bax', 1)).to.eventually.deep.equal([
        { id: 1, array: [{ text: '$foo2' }], object: { num: 0 } },
      ])
    })
  }

  export function selection(database: Database<Tables>) {
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
        { obj: { id: 3, value: 2 } },
      ])
    })

    it('$.object using spread', async () => {
      const res = await database.select('foo')
        .project({
          obj: row => $.object({
            id2: row.id,
            ...row,
          })
        })
        .orderBy(row => row.obj.id)
        .execute()

      expect(res).to.deep.equal([
        { obj: { id2: 1, id: 1, value: 0 } },
        { obj: { id2: 2, id: 2, value: 2 } },
        { obj: { id2: 3, id: 3, value: 2 } },
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
          }),
        })
        .execute()

      expect(res).to.deep.equal([
        { obj: { a: 1, num: 1, obj: { a: 1, b: '1' }, str: 'a', str2: '1' } },
        { obj: { a: 2, num: 2, obj: { a: 2, b: '2' }, str: 'b', str2: '2' } },
        { obj: { a: 3, num: 3, obj: { a: 3, b: '3' }, str: 'c', str2: '3' } },
      ])
    })

    it('project in json with nested object', async () => {
      const res = await database.select('bar')
        .project({
          'obj.num': row => row.obj.x,
          'obj.str': row => row.obj.y,
          'obj.str2': row => row.obj.z,
          'obj.obj': row => row.obj.o,
          'obj.a': row => row.obj.o.a,
        })
        .execute()

      expect(res).to.deep.equal([
        { obj: { a: 1, num: 1, obj: { a: 1, b: '1' }, str: 'a', str2: '1' } },
        { obj: { a: 2, num: 2, obj: { a: 2, b: '2' }, str: 'b', str2: '2' } },
        { obj: { a: 3, num: 3, obj: { a: 3, b: '3' }, str: 'c', str2: '3' } },
      ])
    })

    it('$.object on row', async () => {
      const res = await database.select('foo')
        .project({
          obj: row => $.object(row),
        })
        .orderBy(row => row.obj.id)
        .execute()

      expect(res).to.deep.equal([
        { obj: { id: 1, value: 0 } },
        { obj: { id: 2, value: 2 } },
        { obj: { id: 3, value: 2 } },
      ])
    })

    it('$.object on cell', async () => {
      const res = await database.join(['foo', 'bar'], (foo, bar) => $.eq(foo.id, bar.pid))
        .groupBy('bar', {
          x: row => $.array($.object(row.foo)),
        })
        .execute(['x'])

      expect(res).to.have.deep.members([
        { x: [{ id: 1, value: 0 }] },
        { x: [{ id: 1, value: 0 }] },
        { x: [{ id: 2, value: 2 }] },
      ])
    })

    it('$.array groupBy', async () => {
      await expect(database.join(['foo', 'bar'], (foo, bar) => $.eq(foo.id, bar.pid))
        .groupBy(['foo'], {
          x: row => $.array(row.bar.obj.x),
          y: row => $.array(row.bar.obj.y),
        })
        .orderBy(row => row.foo.id)
        .execute()
      ).to.eventually.have.shape([
        { foo: { id: 1, value: 0 }, x: [1, 2], y: ['a', 'b'] },
        { foo: { id: 2, value: 2 }, x: [3], y: ['c'] },
      ])

      await expect(database.join(['foo', 'bar'], (foo, bar) => $.eq(foo.id, bar.pid))
        .groupBy(['foo'], {
          x: row => $.array(row.bar.obj.x),
          y: row => $.array(row.bar.obj.y),
        })
        .orderBy(row => row.foo.id)
        .execute(row => $.array(row.y))
      ).to.eventually.have.shape([
        ['a', 'b'],
        ['c'],
      ])

      await expect(database.join(['foo', 'bar'], (foo, bar) => $.eq(foo.id, bar.pid))
        .groupBy(['foo'], {
          x: row => $.array(row.bar.obj.x),
          y: row => $.array(row.bar.obj.y),
        })
        .orderBy(row => row.foo.id)
        .execute(row => $.count(row.y))
      ).to.eventually.deep.equal(2)
    })

    it('$.array groupFull', async () => {
      const res = await database.select('bar')
        .groupBy({}, {
          count2: row => $.array(row.s),
          countnumber: row => $.array(row.value),
          x: row => $.array(row.obj.x),
          y: row => $.array(row.obj.y),
        })
        .execute()

      expect(res).to.deep.equal([
        {
          count2: ['1', '2', '3'],
          countnumber: [0, 1, 0],
          x: [1, 2, 3],
          y: ['a', 'b', 'c'],
        },
      ])
    })

    it('$.array in json', async () => {
      const res = await database.join(['foo', 'bar'], (foo, bar) => $.eq(foo.id, bar.pid))
        .groupBy('foo', {
          bars: row => $.array($.object({
            value: row.bar.value,
            obj: row.bar.obj,
          })),
          x: row => $.array(row.bar.obj.x),
          y: row => $.array(row.bar.obj.y),
          z: row => $.array(row.bar.obj.z),
          o: row => $.array(row.bar.obj.o),
        })
        .orderBy(row => row.foo.id)
        .execute()

      expect(res).to.have.shape([
        {
          foo: { id: 1, value: 0 },
          bars: [{
            obj: { o: { a: 1, b: '1' }, x: 1, y: 'a', z: '1' },
            value: 0,
          }, {
            obj: { o: { a: 2, b: '2' }, x: 2, y: 'b', z: '2' },
            value: 1,
          }],
          x: [1, 2],
          y: ['a', 'b'],
          z: ['1', '2'],
          o: [{ a: 1, b: '1' }, { a: 2, b: '2' }],
        },
        {
          foo: { id: 2, value: 2 },
          bars: [{
            obj: { o: { a: 3, b: '3' }, x: 3, y: 'c', z: '3' },
            value: 0,
          }],
          x: [3],
          y: ['c'],
          z: ['3'],
          o: [{ a: 3, b: '3' }],
        },
      ])
    })

    it('$.array with expressions', async () => {
      const res = await database.join(['foo', 'bar'], (foo, bar) => $.eq(foo.id, bar.pid))
        .groupBy('foo', {
          bars: row => $.array($.object({
            value: row.bar.value,
            value2: $.add(row.bar.value, row.foo.value),
          })),
          x: row => $.array($.add(1, row.bar.obj.x)),
          y: row => $.array(row.bar.obj.y),
        })
        .orderBy(row => row.foo.id)
        .execute()

      expect(res).to.have.shape([
        {
          foo: { id: 1, value: 0 },
          bars: [{ value: 0, value2: 0 }, { value: 1, value2: 1 }],
          x: [2, 3],
          y: ['a', 'b'],
        },
        {
          foo: { id: 2, value: 2 },
          bars: [{ value: 0, value2: 2 }],
          x: [4],
          y: ['c'],
        },
      ])
    })

    it('$.array nested', async () => {
      const res = await database.join(['foo', 'bar'], (foo, bar) => $.eq(foo.id, bar.pid))
        .orderBy(row => row.foo.id)
        .groupBy('foo', {
          y: row => $.array(row.bar.obj.x),
        })
        .groupBy({}, {
          z: row => $.array(row.y),
        })
        .execute()

      expect(res).to.have.shape([
        {
          z: [[1, 2], [3]],
        },
      ])
    })

    it('non-aggr func', async () => {
      const res = await database.join(['foo', 'bar'], (foo, bar) => $.eq(foo.id, bar.pid))
        .groupBy('foo', {
          y: row => $.array(row.bar.obj.x),
        })
        .project({
          sum: row => $.sum(row.y),
          avg: row => $.avg(row.y),
          min: row => $.min(row.y),
          max: row => $.max(row.y),
          count: row => $.length(row.y),
        })
        .orderBy(row => row.count)
        .execute()

      expect(res).to.deep.equal([
        { sum: 3, avg: 3, min: 3, max: 3, count: 1 },
        { sum: 3, avg: 1.5, min: 1, max: 2, count: 2 },
      ])
    })

    it('non-aggr func inside aggr', async () => {
      const res = await database.join(['foo', 'bar'], (foo, bar) => $.eq(foo.id, bar.pid))
        .orderBy(row => row.foo.id)
        .groupBy('foo', {
          y: row => $.array(row.bar.obj.x),
        })
        .groupBy({}, {
          sum: row => $.avg($.sum(row.y)),
          avg: row => $.avg($.avg(row.y)),
          min: row => $.min($.min(row.y)),
          max: row => $.max($.max(row.y)),
        })
        .execute()

      expect(res).to.deep.equal([
        { sum: 3, avg: 2.25, min: 1, max: 3 },
      ])
    })

    it('pass sqlType', async () => {
      const res = await database.select('bar')
        .project({
          x: row => row.l,
          y: row => row.obj,
        })
        .execute()

      expect(res).to.deep.equal([
        { x: ['1', '2'], y: { x: 1, y: 'a', z: '1', o: { a: 1, b: '1' } } },
        { x: ['5', '3', '4'], y: { x: 2, y: 'b', z: '2', o: { a: 2, b: '2' } } },
        { x: ['2'], y: { x: 3, y: 'c', z: '3', o: { a: 3, b: '3' } } },
      ])
    })

    it('pass sqlType in join', async () => {
      const res = await database.join({
        foo: 'foo',
        bar: 'bar',
      }, ({ foo, bar }) => $.eq(foo.id, bar.pid))
        .project({
          x: row => row.bar.l,
          y: row => row.bar.obj,
        })
        .execute()

      expect(res).to.have.deep.members([
        { x: ['1', '2'], y: { x: 1, y: 'a', z: '1', o: { a: 1, b: '1' } } },
        { x: ['5', '3', '4'], y: { x: 2, y: 'b', z: '2', o: { a: 2, b: '2' } } },
        { x: ['2'], y: { x: 3, y: 'c', z: '3', o: { a: 3, b: '3' } } },
      ])
    })
  }
}

export default JsonTests
