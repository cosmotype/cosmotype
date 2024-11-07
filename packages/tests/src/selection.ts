import { $, Database } from 'minato'
import { expect } from 'chai'
import { setup } from './utils'

interface Foo {
  id: number
  value: number
  deprecated: number
}

interface Bar {
  id: number
  uid: number
  pid: number
  value: number
}

interface Tables {
  foo: Foo
  bar: Bar
}

function SelectionTests(database: Database<Tables>) {
  database.extend('foo', {
    id: 'unsigned',
    value: 'integer',
  })

  database.migrate('foo', { deprecated: 'unsigned' }, async () => { })

  database.extend('bar', {
    id: 'unsigned',
    uid: 'unsigned',
    pid: 'unsigned',
    value: 'integer',
  }, {
    autoInc: true,
  })

  before(async () => {
    await setup(database, 'foo', [
      { id: 1, value: 0 },
      { id: 2, value: 2 },
      { id: 3, value: 2 },
    ])

    await setup(database, 'bar', [
      { uid: 1, pid: 1, value: 0 },
      { uid: 1, pid: 1, value: 1 },
      { uid: 1, pid: 2, value: 0 },
      { uid: 1, pid: 3, value: 1 },
      { uid: 2, pid: 1, value: 1 },
      { uid: 2, pid: 1, value: 1 },
    ])
  })
}

namespace SelectionTests {
  export function sort(database: Database<Tables>) {
    it('shorthand', async () => {
      await expect(database.get('foo', {}, {
        sort: { id: 'desc', value: 'asc' }
      })).to.eventually.deep.equal([
        { id: 3, value: 2 },
        { id: 2, value: 2 },
        { id: 1, value: 0 },
      ])

      await expect(database.get('foo', {}, {
        sort: { value: 'asc', id: 'desc' }
      })).to.eventually.deep.equal([
        { id: 1, value: 0 },
        { id: 3, value: 2 },
        { id: 2, value: 2 },
      ])
    })

    it('callback', async () => {
      await expect(database
        .select('foo')
        .orderBy(row => $.subtract(row.id, row.value))
        .execute()
      ).to.eventually.deep.equal([
        { id: 2, value: 2 },
        { id: 1, value: 0 },
        { id: 3, value: 2 },
      ])
    })

    it('limit', async () => {
      await expect(database
        .select('foo')
        .orderBy('id', 'desc')
        .limit(1)
        .offset(2)
        .execute()
      ).to.eventually.deep.equal([
        { id: 1, value: 0 },
      ])
    })

    it('random', async () => {
      await expect(database.select('foo').orderBy(row => $.random()).execute(['id'])).to.eventually.have.deep.members([
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ])
    })
  }

  export function project(database: Database<Tables>) {
    it('shorthand', async () => {
      await expect(database.get('foo', {}, ['id'])).to.eventually.deep.equal([
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ])

      await expect(database.select('foo', row => $.eq(row.id, 1)).orderBy('id').execute(['id'])).to.eventually.deep.equal([
        { id: 1 },
      ])
    })

    it('callback', async () => {
      await expect(database
        .select('foo')
        .project({
          id: row => $.add($.multiply(row.id, row.id), 1),
        })
        .execute()
      ).to.eventually.deep.equal([
        { id: 2 },
        { id: 5 },
        { id: 10 },
      ])
    })

    it('chaining', async () => {
      await expect(database
        .select('foo')
        .project({
          id: row => $.multiply(row.id, row.id),
        })
        .project({
          id: row => $.add(row.id, 1),
        })
        .execute()
      ).to.eventually.deep.equal([
        { id: 2 },
        { id: 5 },
        { id: 10 },
      ])
    })

    it('aggregate', async () => {
      await expect(database.select('foo')
        .groupBy({}, {
          count: row => $.count(row.id),
          size: row => $.length(row.id),
          max: row => $.max(row.id),
          min: row => $.min(row.id),
          avg: row => $.avg(row.id),
        })
        .execute()
      ).to.eventually.deep.equal([
        { avg: 2, count: 3, max: 3, min: 1, size: 3 },
      ])
    })
  }

  export function aggregate(database: Database<Tables>) {
    it('shorthand', async () => {
      await expect(database.eval('foo', row => $.sum(row.id))).to.eventually.equal(6)
      await expect(database.eval('foo', row => $.count(row.value))).to.eventually.equal(2)
      await expect(database.eval('foo', row => $.count(row.value), { id: -1 })).to.eventually.equal(0)
    })

    it('inner expressions', async () => {
      await expect(database
        .select('foo')
        .execute(row => $.avg($.multiply($.subtract(row.id, 1), row.value)))
      ).to.eventually.equal(2)
    })

    it('outer expressions', async () => {
      await expect(database
        .select('foo')
        .execute(row => $.subtract($.sum(row.id), $.count(row.value)))
      ).to.eventually.equal(4)
    })

    it('chaining', async () => {
      await expect(database
        .select('foo')
        .project({
          value: row => $.multiply($.subtract(row.id, 1), row.value),
        })
        .execute(row => $.avg(row.value))
      ).to.eventually.equal(2)
    })
  }

  export function group(database: Database<Tables>) {
    it('multiple', async () => {
      await expect(database
        .select('foo')
        .groupBy(['id', 'value'])
        .orderBy('id')
        .execute()
      ).to.eventually.deep.equal([
        { id: 1, value: 0 },
        { id: 2, value: 2 },
        { id: 3, value: 2 },
      ])
    })

    it('callback', async () => {
      await expect(database
        .select('foo')
        .groupBy({
          key: row => $.subtract(row.id, row.value),
        })
        .orderBy('key')
        .execute()
      ).to.eventually.deep.equal([
        { key: 0 },
        { key: 1 },
      ])
    })

    it('extra', async () => {
      await expect(database
        .select('foo')
        .groupBy('value', {
          sum: row => $.sum(row.id),
          count: row => $.count(row.id),
        })
        .orderBy('value')
        .execute()
      ).to.eventually.deep.equal([
        { value: 0, sum: 1, count: 1 },
        { value: 2, sum: 5, count: 2 },
      ])

      await expect(database
        .select('foo')
        .groupBy('value', row => ({
          sum: $.sum(row.id),
          count: $.count(row.id),
        }))
        .orderBy('value')
        .execute()
      ).to.eventually.deep.equal([
        { value: 0, sum: 1, count: 1 },
        { value: 2, sum: 5, count: 2 },
      ])
    })

    it('having', async () => {
      await expect(database
        .select('foo')
        .having(row => $.gt($.sum(row.id), 1))
        .groupBy('value')
        .execute()
      ).to.eventually.deep.equal([
        { value: 2 },
      ])
    })

    it('chaining', async () => {
      await expect(database
        .select('bar')
        .groupBy(['uid', 'pid'], {
          submit: row => $.sum(1),
          accept: row => $.sum(row.value),
        })
        .groupBy(['uid'], {
          submit: row => $.sum(row.submit),
          accept: row => $.sum($.if($.gt(row.accept, 0), 1, 0)),
        })
        .orderBy('uid')
        .execute()
      ).to.eventually.deep.equal([
        { uid: 1, submit: 4, accept: 2 },
        { uid: 2, submit: 2, accept: 1 },
      ])
    })
  }

  export function join(database: Database<Tables>) {
    it('inner join', async () => {
      await expect(database
        .join(['foo', 'bar'])
        .execute()
      ).to.eventually.have.length(18)

      await expect(database
        .join(['foo', 'bar'], (foo, bar) => $.eq(foo.value, bar.value))
        .execute()
      ).to.eventually.have.length(2)

      await expect(database.select('foo')
        .join('bar', database.select('bar'), (foo, bar) => $.eq(foo.value, bar.value))
        .execute()
      ).to.eventually.have.length(2)
    })

    it('left join', async () => {
      await expect(database
        .join(['foo', 'bar'], (foo, bar) => $.eq(foo.value, bar.value), [false, true])
        .execute()
      ).to.eventually.have.shape([
        {
          foo: { value: 0, id: 1 },
          bar: { uid: 1, pid: 1, value: 0, id: 1 },
        },
        {
          foo: { value: 0, id: 1 },
          bar: { uid: 1, pid: 2, value: 0, id: 3 },
        },
        { foo: { value: 2, id: 2 }, bar: {} },
        { foo: { value: 2, id: 3 }, bar: {} },
      ])

      await expect(database
        .join(['foo', 'bar'], (foo, bar) => $.eq(foo.value, bar.value), [true, false])
        .execute()
      ).to.eventually.have.shape([
        {
          bar: { uid: 1, pid: 1, value: 0, id: 1 },
          foo: { value: 0, id: 1 },
        },
        { bar: { uid: 1, pid: 1, value: 1, id: 2 }, foo: {} },
        {
          bar: { uid: 1, pid: 2, value: 0, id: 3 },
          foo: { value: 0, id: 1 },
        },
        { bar: { uid: 1, pid: 3, value: 1, id: 4 }, foo: {} },
        { bar: { uid: 2, pid: 1, value: 1, id: 5 }, foo: {} },
        { bar: { uid: 2, pid: 1, value: 1, id: 6 }, foo: {} },
      ])

      await expect(database.select('foo')
        .join('bar', database.select('bar'), (foo, bar) => $.eq(foo.value, bar.value), true)
        .execute()
      ).to.eventually.have.shape([
        {
          value: 0, id: 1,
          bar: { uid: 1, pid: 1, value: 0, id: 1 },
        },
        {
          value: 0, id: 1,
          bar: { uid: 1, pid: 2, value: 0, id: 3 },
        },
        { value: 2, id: 2 },
        { value: 2, id: 3 },
      ])

      await expect(database.select('bar')
        .join('foo', database.select('foo'), (bar, foo) => $.eq(foo.value, bar.value), true)
        .execute()
      ).to.eventually.have.shape([
        {
          uid: 1, pid: 1, value: 0, id: 1,
          foo: { value: 0, id: 1 },
        },
        { uid: 1, pid: 1, value: 1, id: 2 },
        {
          uid: 1, pid: 2, value: 0, id: 3,
          foo: { value: 0, id: 1 },
        },
        { uid: 1, pid: 3, value: 1, id: 4 },
        { uid: 2, pid: 1, value: 1, id: 5 },
        { uid: 2, pid: 1, value: 1, id: 6 },
      ])
    })

    it('duplicate', async () => {
      await expect(database.select('foo')
        .project(['value'])
        .join('bar', database.select('bar'), (foo, bar) => $.eq(foo.value, bar.uid))
        .execute()
      ).to.eventually.have.length(4)
    })

    it('left join', async () => {
      await expect(database
        .join(['foo', 'bar'], (foo, bar) => $.eq(foo.value, bar.value), [false, true])
        .execute()
      ).to.eventually.have.shape([
        {
          foo: { value: 0, id: 1 },
          bar: { uid: 1, pid: 1, value: 0, id: 1 },
        },
        {
          foo: { value: 0, id: 1 },
          bar: { uid: 1, pid: 2, value: 0, id: 3 },
        },
        { foo: { value: 2, id: 2 }, bar: {} },
        { foo: { value: 2, id: 3 }, bar: {} },
      ])

      await expect(database
        .join(['foo', 'bar'], (foo, bar) => $.eq(foo.value, bar.value), [true, false])
        .execute()
      ).to.eventually.have.shape([
        {
          bar: { uid: 1, pid: 1, value: 0, id: 1 },
          foo: { value: 0, id: 1 },
        },
        { bar: { uid: 1, pid: 1, value: 1, id: 2 }, foo: {} },
        {
          bar: { uid: 1, pid: 2, value: 0, id: 3 },
          foo: { value: 0, id: 1 },
        },
        { bar: { uid: 1, pid: 3, value: 1, id: 4 }, foo: {} },
        { bar: { uid: 2, pid: 1, value: 1, id: 5 }, foo: {} },
        { bar: { uid: 2, pid: 1, value: 1, id: 6 }, foo: {} },
      ])
    })

    it('group', async () => {
      await expect(database.join(['foo', 'bar'], (foo, bar) => $.eq(foo.id, bar.pid))
        .groupBy('foo', { count: row => $.sum(row.bar.uid) })
        .orderBy(row => row.foo.id)
        .execute()).to.eventually.deep.equal([
          { foo: { id: 1, value: 0 }, count: 6 },
          { foo: { id: 2, value: 2 }, count: 1 },
          { foo: { id: 3, value: 2 }, count: 1 },
        ])
    })

    it('selections', async () => {
      await expect(database
        .join({
          all: 'bar',
          index: database.select('bar').groupBy('uid', { id: row => $.max(row.id) })
        }, ({ all, index }) => $.eq(all.id, index.id))
        .execute(['all'])
      ).to.eventually.have.shape([
        { all: { id: 4, uid: 1, pid: 3, value: 1 } },
        { all: { id: 6, uid: 2, pid: 1, value: 1 } },
      ])

      await expect(database
        .join({
          all: 'bar',
          index: database.select('bar').where(row => $.gt(row.id, 0))
        }, ({ all, index }) => $.eq(all.id, index.id))
        .execute(['all'])
      ).to.eventually.have.length(6)

      await expect(database
        .join({
          t1: database.select('bar').where(row => $.gt(row.pid, 1)),
          t2: database.select('bar').where(row => $.gt(row.uid, 1)),
          t3: database.select('bar').where(row => $.gt(row.id, 4)),
        }, ({ t1, t2, t3 }) => $.gt($.add(t1.id, t2.id, t3.id), 14))
        .execute()
      ).to.eventually.have.length(4)

      await expect(database.select('bar').where(row => $.gt(row.pid, 1))
        .join('t2', database.select('bar').where(row => $.gt(row.uid, 1)))
        .join('t3', database.select('bar').where(row => $.gt(row.id, 4)), (self, t3) => $.gt($.add(self.id, self.t2.id, t3.id), 14))
        .execute()
      ).to.eventually.have.length(4)
    })

    it('aggregate', async () => {
      await expect(database
        .join(['foo', 'bar'])
        .execute(row => $.count(row.bar.id))
      ).to.eventually.equal(6)

      await expect(database
        .join(['foo', 'bar'])
        .where(row => $.gt(row.bar.id, 3))
        .execute(row => $.count(row.bar.id))
      ).to.eventually.equal(3)

      await expect(database
        .join(['foo', 'bar'])
        .where(row => $.gt(row.bar.id, 3))
        .orderBy(row => row.bar.id)
        .execute(row => $.count(row.bar.id))
      ).to.eventually.equal(3)
    })
  }

  export function subquery(database: Database<Tables>) {
    it('select', async () => {
      await expect(database.select('foo')
        .project({
          x: r1 => database
            .select('foo', r2 => $.gt(r1.id, r2.id))
            .evaluate(r2 => $.count(r2.id)),
        })
        .orderBy('x')
        .execute()).to.eventually.deep.equal([
          { x: 0 },
          { x: 1 },
          { x: 2 },
        ])
    })

    it('where', async () => {
      await expect(database.get('foo', row => $.in(
        row.id, database.select('foo').project({ x: row => $.add(row.id, 1) }).evaluate('x')
      ))).to.eventually.deep.equal([
        { id: 2, value: 2 },
        { id: 3, value: 2 },
      ])

      await expect(database.get('foo', row => $.in(
        [row.id, row.id], database.select('foo').project({ x: row => $.add(row.id, 1) }).evaluate(['x', 'x'])
      ))).to.eventually.deep.equal([
        { id: 2, value: 2 },
        { id: 3, value: 2 },
      ])

      await expect(database.get('foo', row => $.in(
        [row.id, row.id], [[2, 2], [3, 3]]
      ))).to.eventually.deep.equal([
        { id: 2, value: 2 },
        { id: 3, value: 2 },
      ])
    })

    it('from', async () => {
      const sel = database.select('foo').project({
        x: row => $.add(row.id, row.value),
        id: 'id'
      })
      await expect(database.select(sel).execute(row => $.sum(row.x))).to.eventually.equal(10)
    })

    it('select join', async () => {
      await expect(database.select('foo')
        .project({
          x: r => database.select('bar')
            .where(row => $.and($.gte(row.pid, r.id), $.lt(row.uid, r.id)))
            .evaluate(row => $.count(row.id)),
        })
        .execute())
        .to.eventually.deep.equal([
          { x: 0 },
          { x: 2 },
          { x: 1 },
        ])
    })

    it('groupBy', async () => {
      const sel = database.select('bar').evaluate(row => $.count(row.id))
      await expect(database
        .select('foo')
        .groupBy({
          key: row => $.subtract(sel, row.value),
        })
        .orderBy('key')
        .execute()
      ).to.eventually.deep.equal([
        { key: 4 },
        { key: 6 },
      ])
    })

    it('having', async () => {
      const sel = database.select('bar').evaluate(row => $.subtract($.count(row.id), 5))
      await expect(database
        .select('foo')
        .having(row => $.gt($.sum(row.id), sel))
        .groupBy('value')
        .execute()
      ).to.eventually.deep.equal([
        { value: 2 },
      ])
    })

    it('nested subquery', async () => {
      const one = database.select('bar').evaluate(row => $.subtract($.count(row.id), 5))
      const sel = x => database.select('bar').evaluate(row => $.add(one, $.subtract($.count(row.id), x), 0))
      await expect(database
        .select('foo')
        .project({
          t: row => row.id,
          x: row => sel(row.id),
        })
        .execute()
      ).to.eventually.deep.equal([
        { t: 1, x: 6 },
        { t: 2, x: 5 },
        { t: 3, x: 4 },
      ])
    })

    it('inner join', async () => {
      const one = database.select('bar').evaluate(row => $.subtract($.count(row.id), 5))
      const sel = x => database.select('bar').where(row => $.eq(x, row.uid)).evaluate(row => $.count(row.id))
      await expect(database
        .join(['foo', 'bar'], (foo, bar) => $.gt(foo.value, one))
        .execute()
      ).to.eventually.have.length(12)

      await expect(database
        .join(['foo', 'bar'], (foo, bar) => $.lt(foo.value, sel(foo.id)))
        .execute()
      ).to.eventually.have.length(6)
    })

    it('selections', async () => {
      const w = x => database.join(['bar', 'foo']).evaluate(row => $.add($.count(row.bar.id), -6, x))
      await expect(database
        .join({
          t1: database.select('bar').where(row => $.gt(w(row.pid), 1)),
          t2: database.select('bar').where(row => $.gt(row.uid, 1)),
          t3: database.select('bar').where(row => $.gt(row.id, w(4))),
        }, ({ t1, t2, t3 }) => $.gt($.add(t1.id, t2.id, w(t3.id)), 14))
        .project({
          val: row => $.add(row.t1.id, row.t2.id, w(row.t3.id)),
        })
        .execute()
      ).to.eventually.have.length(4)
    })

    it('access from join', async () => {
      const w = x => database.select('bar').evaluate(row => $.add($.count(row.id), -6, x))
      await expect(database
        .join(['foo', 'bar'], (foo, bar) => $.gt(foo.id, w(bar.pid)))
        .execute()
      ).to.eventually.have.length(9)
    })

    it('join selection', async () => {
      await expect(database
        .select(
          database.select('foo'),
        )
        .execute()
      ).to.eventually.have.length(3)

      await expect(database
        .join({
          foo1: database.select('foo'),
          foo2: database.select('foo'),
        })
        .execute()
      ).to.eventually.have.length(9)
    })

    it('return array', async () => {
      await expect(database.select('foo')
        .project({
          x: r => database.select('bar')
            .where(row => $.and($.gte(row.pid, r.id), $.lt(row.uid, r.id)))
            .evaluate('id'),
        })
        .execute())
        .to.eventually.deep.equal([
          { x: [] },
          { x: [3, 4] },
          { x: [4] },
        ])
    })

    it('return nested array', async () => {
      await expect(database.select('foo')
        .project({
          x: r => database.select('bar')
            .where(row => $.and($.gte(row.pid, r.id), $.lt(row.uid, r.id)))
            .project({
              id: _ => database.select('foo').project({
                id: row => $.add(row.id, r.id),
              }).evaluate('id'),
            })
            .evaluate('id')
        })
        .execute())
        .to.eventually.deep.equal([
          { x: [] },
          { x: [[3, 4, 5], [3, 4, 5]] },
          { x: [[4, 5, 6]] },
        ])

      await expect(database.select('foo')
        .project({
          x: r => database.select('bar')
            .where(row => $.and($.gte(row.pid, r.id), $.lt(row.uid, r.id)))
            .project({
              id: _ => database.select('foo').project({
                id: row => $.add(row.id, r.id),
              }).evaluate('id'),
            })
            .evaluate('id')
        })
        .execute(row => $.array(row.x)))
        .to.eventually.deep.equal([
          [],
          [[3, 4, 5], [3, 4, 5]],
          [[4, 5, 6]],
        ])
    })

    it('return array of objects', async () => {
      await expect(database.select('foo')
        .project({
          x: r => database.select('bar')
            .where(row => $.and($.gte(row.pid, r.id), $.lt(row.uid, r.id)))
            .evaluate(),
        })
        .orderBy(row => $.length(row.x))
        .execute())
        .to.eventually.have.shape([
          { x: [] },
          { x: [{ id: 4 }] },
          { x: [{ id: 3 }, { id: 4 }] },
        ])
    })

    it('return aggregate', async () => {
      await expect(database.select('foo')
        .project({ x: row => database.select('bar', r => $.eq(r.pid, row.id)).evaluate(r => $.max(r.value)) })
        .execute()
      ).to.eventually.have.shape([
        { x: 1 },
        { x: 0 },
        { x: 1 },
      ])
    })
  }
}

export default SelectionTests
