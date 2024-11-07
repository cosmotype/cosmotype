import { $, Database } from 'minato'
import { expect } from 'chai'

interface ObjectModel {
  id: string
  meta?: {
    a?: string
    embed?: {
      b?: number
      c?: string
      d?: {
        foo?: number
        bar?: object
      }
    }
  }
}

interface Tables {
  object: ObjectModel
}

function ObjectOperations(database: Database<Tables>) {
  database.extend('object', {
    'id': 'string',
    'meta.a': { type: 'string', initial: '666' },
    'meta.embed': { type: 'json', initial: { c: 'world' } },
  })
}

namespace ObjectOperations {
  async function setup(database: Database<Tables>) {
    await database.remove('object', {})
    const result: ObjectModel[] = []
    result.push(await database.create('object', { id: '0', meta: { a: '233', embed: { b: 2, c: 'hello' } } }))
    result.push(await database.create('object', { id: '1' }))
    expect(result).to.have.length(2)
    return result
  }

  export const create = function Create(database: Database<Tables>) {
    it('initial value', async () => {
      const table = await setup(database)
      table.push(await database.create('object', { id: '2', meta: { embed: { b: 999 } } }))
      expect(table[table.length - 1]).to.deep.equal({
        id: '2', meta: { a: '666', embed: { b: 999 } }
      })
      await expect(database.get('object', {})).to.eventually.deep.equal(table)
    })
  }

  export const get = function Get(database: Database<Tables>) {
    it('field extraction', async () => {
      await setup(database)
      const table = await database.get('object', {}, ['meta'])
      expect(table).to.deep.equal([
        { meta: { a: '233', embed: { b: 2, c: 'hello' } } },
        { meta: { a: '666', embed: { c: 'world' } } },
      ])
    })

    it('selection', async () => {
      await setup(database)
      await expect(database.select('object', '0').project({ x: row => row.meta.embed.c }).execute()).to.eventually.deep.equal([{ x: 'hello' }])
    })
  }

  export const upsert = function Upsert(database: Database<Tables>) {
    it('object literal', async () => {
      const table = await setup(database)
      table[0].meta = { a: '233', embed: { b: 114 } }
      table[1].meta = { a: '1', embed: { b: 514, c: 'world' } }
      table.push({ id: '2', meta: { a: '666', embed: { b: 1919 } } })
      table.push({ id: '3', meta: { a: 'foo', embed: { b: 810, c: 'world' } } })
      await expect(database.upsert('object', (row) => [
        { id: '0', meta: { embed: { b: 114 } } },
        { id: '1', meta: { a: row.id, 'embed.b': $.add(500, 14) } },
        { id: '2', meta: { embed: { b: 1919 } } },
        { id: '3', meta: { a: 'foo', 'embed.b': 810 } },
      ])).eventually.fulfilled
      await expect(database.get('object', {})).to.eventually.deep.equal(table)
    })

    it('nested property', async () => {
      const table = await setup(database)
      table[0].meta = { a: '0', embed: { b: 114, c: 'hello' } }
      table[1].meta = { a: '1', embed: { b: 514 } }
      table.push({ id: '2', meta: { a: '2', embed: { b: 1919, c: 'world' } } })
      table.push({ id: '3', meta: { a: '3', embed: { b: 810 } } })
      await expect(database.upsert('object', row => [
        { id: '0', 'meta.a': row.id, 'meta.embed.b': 114 },
        { id: '1', 'meta.a': row.id, 'meta.embed': { b: 514 } },
        { id: '2', 'meta.a': row.id, 'meta.embed.b': $.multiply(19, 101) },
        { id: '3', 'meta.a': row.id, 'meta.embed': { b: 810 } },
      ])).eventually.fulfilled
      await expect(database.get('object', {})).to.eventually.deep.equal(table)
    })

    it('empty object override', async () => {
      const table = await setup(database)
      table[0]!.meta!.embed = {}
      await database.upsert('object', [{ id: '0', meta: { embed: {} } }])
      await expect(database.get('object', {})).to.eventually.have.deep.members(table)
    })

    it('expressions w/ json object', async () => {
      const table = await setup(database)
      table[0]!.meta!.a = table[0]!.meta!.embed!.c + 'a'
      table[1]!.meta!.embed!.b = 1
      await database.upsert('object', row => [
        { id: '0', meta: { a: $.concat(row.meta.embed.c, 'a') } },
        { id: '1', 'meta.embed.b': $.add($.ifNull(row.meta.embed.b, 0), 1) },
      ])
      await expect(database.get('object', {})).to.eventually.have.deep.members(table)
    })

    it('expressions w/o json object', async () => {
      const table = await setup(database)
      table[0]!.meta!.a = table[0]!.meta!.a + 'a'
      await database.upsert('object', row => [{ id: '0', meta: { a: $.concat(row.meta.a, 'a') } }])
      await expect(database.get('object', {})).to.eventually.have.deep.members(table)
    })
  }

  export const modify = function Modify(database: Database<Tables>) {
    it('object literal', async () => {
      const table = await setup(database)
      table[0].meta = { a: '0', embed: { b: 114 } }
      table[1].meta = { a: '1', embed: { b: 514, c: 'world' } }
      await expect(database.set('object', '0', (row) => ({
        meta: { a: row.id, embed: { b: 114 } },
      }))).eventually.fulfilled
      await expect(database.set('object', '1', (row) => ({
        meta: { a: row.id, 'embed.b': 514 },
      }))).eventually.fulfilled
      await expect(database.get('object', {})).to.eventually.deep.equal(table)
    })

    it('using subquery', async () => {
      const table = await setup(database)
      table[0].meta = { a: '0', embed: { b: 114 } }
      table[1].meta = { a: '1', embed: { b: 514, c: 'world' } }
      await expect(database.set('object',
        row => $.eq(row.id, database.select('object', '0').evaluate(r => $.max(r.id))),
        row => ({
          meta: { a: row.id, embed: { b: 114 } },
        })),
      ).eventually.fulfilled
      await expect(database.set('object',
        row => $.eq(row.id, database.select('object', '1').evaluate(r => $.max(r.id))),
        row => ({
          meta: { a: row.id, 'embed.b': 514 },
        }),
      )).eventually.fulfilled
      await expect(database.get('object', {})).to.eventually.deep.equal(table)
    })

    it('nested property', async () => {
      const table = await setup(database)
      table[0].meta = { a: '0', embed: { b: 114, c: 'hello' } }
      table[1].meta = { a: '1', embed: { b: 514 } }
      await expect(database.set('object', '0', row => ({
        'meta.a': row.id,
        'meta.embed.b': 114,
      }))).eventually.fulfilled
      await expect(database.set('object', '1', row => ({
        'meta.a': row.id,
        'meta.embed': { b: 514 },
      }))).eventually.fulfilled
      await expect(database.get('object', {})).to.eventually.deep.equal(table)
    })

    it('empty object override', async () => {
      const table = await setup(database)
      table[0]!.meta!.embed = {}
      await database.set('object', { id: '0' }, { meta: { embed: {} } })
      await expect(database.get('object', {})).to.eventually.have.deep.members(table)
    })

    it('expressions w/ json object', async () => {
      const table = await setup(database)
      table[0]!.meta!.a = table[0]!.meta!.embed!.c + 'a'
      await database.set('object', { id: '0' }, row => ({ meta: { a: $.concat(row.meta.embed.c, 'a') } }))
      await expect(database.get('object', {})).to.eventually.have.deep.members(table)
    })

    it('expressions w/o json object', async () => {
      const table = await setup(database)
      table[0]!.meta!.a = table[0]!.meta!.a + 'a'
      await database.set('object', { id: '0' }, row => ({ meta: { a: $.concat(row.meta.a, 'a') } }))
      await expect(database.get('object', {})).to.eventually.have.deep.members(table)
    })

    it('object in json', async () => {
      const table = await setup(database)
      table[1]!.meta!.embed!.d = {}
      await database.set('object', { id: '1' }, { 'meta.embed.d': {} })
      await expect(database.get('object', {})).to.eventually.have.deep.members(table)
      table[0]!.meta!.embed!.d = { foo: 1, bar: { a: 3, b: 4 } }
      await database.set('object', { id: '0' }, { 'meta.embed.d': { foo: 1, bar: { a: 3, b: 4 } } })
      await expect(database.get('object', {})).to.eventually.have.deep.members(table)
    })

    it('nested object in json', async () => {
      const table = await setup(database)
      table[0]!.meta!.embed!.d = { foo: 2, bar: { a: 1 } }
      await database.set('object', { id: '0' }, { 'meta.embed.d.bar': { a: 1 }, 'meta.embed.d.foo': 2 })
      await expect(database.get('object', {})).to.eventually.have.deep.members(table)
    })

    it('$.number in json', async () => {
      const table = await setup(database)
      table[0]!.meta!.embed!.b = 233
      table[1]!.meta!.embed!.b = 666
      await database.set('object', {}, row => ({ 'meta.embed.b': $.number(row.meta.a) }))
      await expect(database.get('object', {})).to.eventually.have.deep.members(table)
    })
  }

  export const misc = function Misc(database: Database<Tables>) {
    it('join selections with dot fields', async () => {
      await setup(database)
      await database.set('object', '1', { 'meta.embed.b': 3 })
      await expect(database.join({
        x: database.select('object').where(row => $.lt(row.meta.embed.b, 100)),
        y: database.select('object').where(row => $.lt(row.meta.embed.b, 100)),
      }).execute(row => $.sum(1))).to.eventually.deep.equal(4)
    })

    it('switch model in object query', async () => {
      const table = await setup(database)
      await expect(database.select('object', {
        'meta.a': '666',
      }).project({
        t: 'meta',
      }).execute()).to.eventually.have.deep.members([{ t: table[1].meta }])
    })

    it('accumlate project', async () => {
      const table = await setup(database)
      await expect(database.select('object', {
        'meta.a': '666',
      }).project(row => ({
        t: 'meta',
        t2: row.meta.embed.c,
        t3: $.concat(row.meta.a, 'my'),
        ...row.meta,
        ...row,
      })).execute()).to.eventually.have.deep.members([{
        t: table[1].meta,
        t2: 'world',
        t3: '666my',
        ...table[1].meta,
        ...table[1],
      }])
    })
  }
}

export default ObjectOperations
