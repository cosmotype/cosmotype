import { Binary, deepEqual, Dict, difference, isNullable, makeArray, mapValues } from 'cosmokit'
import { Driver, Eval, executeUpdate, Field, getCell, hasSubquery, isEvalExpr, Selection, z } from 'minato'
import { escapeId } from '@minatojs/sql-utils'
import { resolve } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import { SQLiteBuilder } from './builder'

function getTypeDef({ deftype: type }: Field) {
  switch (type) {
    case 'primary':
    case 'boolean':
    case 'integer':
    case 'unsigned':
    case 'bigint':
    case 'date':
    case 'time':
    case 'timestamp': return `INTEGER`
    case 'float':
    case 'double':
    case 'decimal': return `REAL`
    case 'char':
    case 'string':
    case 'text':
    case 'list':
    case 'json': return `TEXT`
    case 'binary': return `BLOB`
    default: throw new Error(`unsupported type: ${type}`)
  }
}

interface SQLiteFieldInfo {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string
  pk: boolean
}

interface SQLiteMasterInfo {
  type: string
  name: string
  tbl_name: string
  sql: string
}

export class SQLiteDriver extends Driver<SQLiteDriver.Config> {
  static name = 'sqlite'

  path!: string
  db!: DatabaseSync
  sql = new SQLiteBuilder(this)
  beforeUnload?: () => void

  private _transactionTask?: Promise<void>

  /** synchronize table schema */
  async prepare(table: string, dropKeys?: string[]) {
    const columns = this._all(`PRAGMA table_info(${escapeId(table)})`) as SQLiteFieldInfo[]
    const model = this.model(table)
    const columnDefs: string[] = []
    const indexDefs: string[] = []
    const alter: string[] = []
    const mapping: Dict<string> = {}
    let shouldMigrate = false

    // field definitions
    for (const key in model.fields) {
      if (!Field.available(model.fields[key])) {
        if (dropKeys?.includes(key)) shouldMigrate = true
        continue
      }

      const legacy = [key, ...model.fields[key]!.legacy || []]
      const column = columns.find(({ name }) => legacy.includes(name))
      const { initial, nullable = true } = model.fields[key]!
      const typedef = getTypeDef(model.fields[key]!)
      let def = `${escapeId(key)} ${typedef}`
      if (key === model.primary && model.autoInc) {
        def += ' NOT NULL PRIMARY KEY AUTOINCREMENT'
      } else {
        def += (nullable ? ' ' : ' NOT ') + 'NULL'
        if (!isNullable(initial)) {
          def += ' DEFAULT ' + this.sql.escape(this.sql.dump({ [key]: initial }, model)[key])
        }
      }
      columnDefs.push(def)
      if (!column) {
        alter.push('ADD ' + def)
      } else {
        mapping[column.name] = key
        shouldMigrate ||= column.name !== key || column.type !== typedef
      }
    }

    // index definitions
    if (model.primary && !model.autoInc) {
      indexDefs.push(`PRIMARY KEY (${this._joinKeys(makeArray(model.primary))})`)
    }
    if (model.unique) {
      indexDefs.push(...model.unique.map(keys => `UNIQUE (${this._joinKeys(makeArray(keys))})`))
    }
    if (model.foreign) {
      indexDefs.push(...Object.entries(model.foreign).map(([key, value]) => {
        const [table, key2] = value!
        return `FOREIGN KEY (\`${key}\`) REFERENCES ${escapeId(table)} (\`${key2}\`)`
      }))
    }

    if (!columns.length) {
      this.logger.info('auto creating table %c', table)
      this._run(`CREATE TABLE ${escapeId(table)} (${[...columnDefs, ...indexDefs].join(', ')})`)
    } else if (shouldMigrate) {
      // preserve old columns
      for (const { name, type, notnull, pk, dflt_value: value } of columns) {
        if (mapping[name] || dropKeys?.includes(name)) continue
        let def = `${escapeId(name)} ${type}`
        def += (notnull ? ' NOT ' : ' ') + 'NULL'
        if (pk) def += ' PRIMARY KEY'
        if (value !== null) def += ' DEFAULT ' + this.sql.escape(value)
        columnDefs.push(def)
        mapping[name] = name
      }

      const temp = table + '_temp'
      const fields = Object.keys(mapping).map(escapeId).join(', ')
      this.logger.info('auto migrating table %c', table)
      this._run(`CREATE TABLE ${escapeId(temp)} (${[...columnDefs, ...indexDefs].join(', ')})`)
      try {
        this._run(`INSERT INTO ${escapeId(temp)} SELECT ${fields} FROM ${escapeId(table)}`)
        this._run(`DROP TABLE ${escapeId(table)}`)
      } catch (error) {
        this._run(`DROP TABLE ${escapeId(temp)}`)
        throw error
      }
      this._run(`ALTER TABLE ${escapeId(temp)} RENAME TO ${escapeId(table)}`)
    } else if (alter.length) {
      this.logger.info('auto updating table %c', table)
      for (const def of alter) {
        this._run(`ALTER TABLE ${escapeId(table)} ${def}`)
      }
    }

    if (dropKeys) return
    dropKeys = []
    await this.migrate(table, {
      error: this.logger.warn,
      before: keys => keys.every(key => columns.some(({ name }) => name === key)),
      after: keys => dropKeys!.push(...keys),
      finalize: () => {
        if (!dropKeys!.length) return
        this.prepare(table, dropKeys)
      },
    })
  }

  async start() {
    this.path = this.config.path
    if (this.path !== ':memory:') {
      this.path = resolve(this.ctx.baseDir, this.path)
    }
    const isBrowser = process.env.KOISHI_ENV === 'browser'
    if (isBrowser) {
      throw new Error('node:sqlite driver is not supported in browser environment')
    }

    const DatabaseSync = await import('node:sqlite').then((m) => m.DatabaseSync)
      .catch(e => {
        if (e.toString().includes('ERR_UNKNOWN_BUILTIN_MODULE')) {
          throw new Error('The sqlite3 module is currently experimental. You have to install Node.JS 22.5+ and run it with --experimental-sqlite to use it.')
        } else {
          throw e
        }
      })

    this.db = new DatabaseSync(this.path)
    // TODO: implement create function after https://github.com/nodejs/node/issues/54349 is resolved
    // this.db.create_function('regexp', (pattern, str) => +new RegExp(pattern).test(str))
    // this.db.create_function('regexp2', (pattern, str, flags) => +new RegExp(pattern, flags).test(str))
    // this.db.create_function('json_array_contains', (array, value) => +(JSON.parse(array) as any[]).includes(JSON.parse(value)))
    // this.db.create_function('modulo', (left, right) => left % right)
    // this.db.create_function('rand', () => Math.random())

    this.define<boolean, number>({
      types: ['boolean'],
      dump: value => isNullable(value) ? value : +value,
      load: (value) => isNullable(value) ? value : !!value,
    })

    this.define<object, string>({
      types: ['json'],
      dump: value => JSON.stringify(value),
      load: value => typeof value === 'string' ? JSON.parse(value) : value,
    })

    this.define<string[], string>({
      types: ['list'],
      dump: value => Array.isArray(value) ? value.join(',') : value,
      load: value => value ? value.split(',') : [],
    })

    this.define<Date, number | bigint>({
      types: ['date', 'time', 'timestamp'],
      dump: value => isNullable(value) ? value as any : +new Date(value),
      load: value => isNullable(value) ? value : new Date(Number(value)),
    })

    this.define<ArrayBuffer, ArrayBuffer>({
      types: ['binary'],
      dump: value => isNullable(value) ? value : new Uint8Array(value),
      load: value => isNullable(value) ? value : Binary.fromSource(value),
    })

    this.define<number, number | bigint>({
      types: ['primary', ...Field.number as any],
      dump: value => value,
      load: value => isNullable(value) ? value : Number(value),
    })
  }

  _joinKeys(keys?: string[]) {
    return keys?.length ? keys.map(key => `\`${key}\``).join(', ') : '*'
  }

  async stop() {
    await new Promise(resolve => setTimeout(resolve, 0))
    this.db?.close()
    if (this.beforeUnload) {
      this.beforeUnload()
      window.removeEventListener('beforeunload', this.beforeUnload)
    }
  }

  _exec(sql: string, params: any, callback: (stmt: StatementSync) => any) {
    try {
      const stmt = this.db.prepare(sql)
      const result = callback(stmt)
      this.logger.debug('> %s', sql, params)
      return result
    } catch (e) {
      this.logger.warn('> %s', sql, params)
      throw e
    }
  }

  _all(sql: string, params: any = [], config?: { useBigInt: boolean }) {
    return this._exec(sql, params, (stmt) => {
      stmt.setReadBigInts(config?.useBigInt || false)
      return stmt.all(...params)
    })
  }

  _get(sql: string, params: any = [], config?: { useBigInt: boolean }) {
    // @ts-ignore
    return this._exec(sql, params, stmt => {
      stmt.setReadBigInts(config?.useBigInt || false)
      return stmt.get(...params)
    })
  }

  _run(sql: string, params: any = [], callback?: () => any) {
    this._exec(sql, params, stmt => stmt.run(...params))
    const result = callback?.()
    return result
  }

  async drop(table: string) {
    this._run(`DROP TABLE ${escapeId(table)}`)
  }

  async dropAll() {
    const tables = Object.keys(this.database.tables)
    for (const table of tables) {
      this._run(`DROP TABLE ${escapeId(table)}`)
    }
  }

  async stats() {
    // TODO: properly estimate size
    const stats: Driver.Stats = { size: 100, tables: {} }
    const tableNames: { name: string }[] = this._all('SELECT name FROM sqlite_master WHERE type="table" ORDER BY name;')
    const dbstats: { name: string; size: number }[] = this._all('SELECT name, pgsize as size FROM "dbstat" WHERE aggregate=TRUE;')
    tableNames.forEach(tbl => {
      stats.tables[tbl.name] = this._get(`SELECT COUNT(*) as count FROM ${escapeId(tbl.name)};`)
      stats.tables[tbl.name].size = dbstats.find(o => o.name === tbl.name)!.size
    })
    return stats
  }

  async remove(sel: Selection.Mutable) {
    const { query, table, tables } = sel
    const builder = new SQLiteBuilder(this, tables)
    const filter = builder.parseQuery(query)
    if (filter === '0') return {}
    const result = this._run(`DELETE FROM ${escapeId(table)} WHERE ${filter}`, [], () => this._get(`SELECT changes() AS count`))
    return { matched: result.count, removed: result.count }
  }

  async get(sel: Selection.Immutable) {
    const { model, tables } = sel
    const builder = new SQLiteBuilder(this, tables)
    const sql = builder.get(sel)
    if (!sql) return []
    const rows: any[] = this._all(sql, [], { useBigInt: true })
    return rows.map(row => builder.load(row, model))
  }

  async eval(sel: Selection.Immutable, expr: Eval.Expr) {
    const builder = new SQLiteBuilder(this, sel.tables)
    const inner = builder.get(sel.table as Selection, true, true)
    const output = builder.parseEval(expr, false)
    const { value } = this._get(`SELECT ${output} AS value FROM ${inner}`, [], { useBigInt: true })
    return builder.load(value, expr)
  }

  _update(sel: Selection.Mutable, indexFields: string[], updateFields: string[], update: {}, data: {}) {
    const { ref, table, tables, model } = sel
    const builder = new SQLiteBuilder(this, tables)
    executeUpdate(data, update, ref)
    const row = builder.dump(data, model)
    const assignment = updateFields.map((key) => `${escapeId(key)} = ?`).join(',')
    const query = Object.fromEntries(indexFields.map(key => [key, row[key]]))
    const filter = builder.parseQuery(query)
    this._run(`UPDATE ${escapeId(table)} SET ${assignment} WHERE ${filter}`, updateFields.map((key) => row[key] ?? null))
  }

  async set(sel: Selection.Mutable, update: {}) {
    const { model, table, query } = sel
    const { primary } = model, fields = model.avaiableFields()
    const updateFields = [...new Set(Object.keys(update).map((key) => {
      return Object.keys(fields).find(field => field === key || key.startsWith(field + '.'))!
    }))]
    const primaryFields = makeArray(primary)
    if (query.$expr || hasSubquery(sel.query) || Object.values(update).some(x => hasSubquery(x))) {
      const sel2 = this.database.select(table as never, query)
      sel2.tables[sel.ref] = sel2.tables[sel2.ref]
      delete sel2.tables[sel2.ref]
      sel2.ref = sel.ref
      const project = mapValues(update as any, (value, key) => () => (isEvalExpr(value) ? value : Eval.literal(value, model.getType(key))))
      const rawUpsert = await sel2.project({
        ...project,
        // do not touch sel2.row since it is not patched
        ...Object.fromEntries(primaryFields.map(x => [x, () => Eval('', [sel.ref, x], sel2.model.getType(x)!)])),
      }).execute()
      const upsert = rawUpsert.map(row => ({
        ...mapValues(update, (_, key) => getCell(row, key)),
        ...Object.fromEntries(primaryFields.map(x => [x, getCell(row, x)])),
      }))
      return this.database.upsert(table, upsert)
    } else {
      const data = await this.database.get(table as never, query)
      for (const row of data) {
        this._update(sel, primaryFields, updateFields, update, row)
      }
      return { matched: data.length }
    }
  }

  _create(table: string, data: {}) {
    const model = this.model(table)
    data = this.sql.dump(data, model)
    const keys = Object.keys(data)
    const sql = `INSERT INTO ${escapeId(table)} (${this._joinKeys(keys)}) VALUES (${Array(keys.length).fill('?').join(', ')})`
    return this._run(sql, keys.map(key => data[key] ?? null), () => this._get(`SELECT last_insert_rowid() AS id`))
  }

  async create(sel: Selection.Mutable, data: {}) {
    const { model, table } = sel
    const { id } = this._create(table, data)
    const { autoInc, primary } = model
    if (!autoInc || Array.isArray(primary)) return data as any
    return { ...data, [primary]: id }
  }

  async upsert(sel: Selection.Mutable, data: any[], keys: string[]) {
    if (!data.length) return {}
    const { model, table, ref } = sel
    const fields = model.avaiableFields()
    const result = { inserted: 0, matched: 0, modified: 0 }
    const dataFields = [...new Set(Object.keys(Object.assign({}, ...data)).map((key) => {
      return Object.keys(fields).find(field => field === key || key.startsWith(field + '.'))!
    }))]
    let updateFields = difference(dataFields, keys)
    if (!updateFields.length) updateFields = [dataFields[0]]
    // Error: Expression tree is too large (maximum depth 1000)
    const step = Math.floor(960 / keys.length)
    for (let i = 0; i < data.length; i += step) {
      const chunk = data.slice(i, i + step)
      const results = await this.database.get(table as never, {
        $or: chunk.map(item => Object.fromEntries(keys.map(key => [key, item[key]]))),
      })
      for (const item of chunk) {
        const row = results.find(row => {
          // flatten key to respect model
          row = model.format(row)
          return keys.every(key => deepEqual(row[key], item[key], true))
        })
        if (row) {
          this._update(sel, keys, updateFields, item, row)
          result.matched++
        } else {
          this._create(table, executeUpdate(model.create(), item, ref))
          result.inserted++
        }
      }
    }
    return result
  }

  async withTransaction(callback: () => Promise<void>) {
    if (this._transactionTask) await this._transactionTask.catch(() => { })
    return this._transactionTask = new Promise<void>((resolve, reject) => {
      this._run('BEGIN TRANSACTION')
      callback().then(
        () => resolve(this._run('COMMIT')),
        (e) => (this._run('ROLLBACK'), reject(e)),
      )
    })
  }

  async getIndexes(table: string) {
    const indexes = this._all(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`, [table]) as SQLiteMasterInfo[]
    const result: Driver.Index[] = []
    for (const { name, sql } of indexes) {
      result.push({
        name,
        unique: !sql || sql.toUpperCase().startsWith('CREATE UNIQUE'),
        keys: this._parseIndexDef(sql),
      })
    }
    return result
  }

  async createIndex(table: string, index: Driver.Index) {
    const name = index.name ?? Object.entries(index.keys).map(([key, direction]) => `${key}_${direction ?? 'asc'}`).join('+')
    const keyFields = Object.entries(index.keys).map(([key, direction]) => `${escapeId(key)} ${direction ?? 'asc'}`).join(', ')
    await this._run(`create ${index.unique ? 'UNIQUE' : ''} index ${escapeId(name)} ON ${escapeId(table)} (${keyFields})`)
  }

  async dropIndex(table: string, name: string) {
    await this._run(`DROP INDEX ${escapeId(name)}`)
  }

  _parseIndexDef(def: string) {
    if (!def) return {}
    try {
      const keys = {}, matches = def.match(/\((.*)\)/)!
      matches[1].split(',').forEach((key) => {
        const [name, direction] = key.trim().split(' ')
        keys[name.startsWith('`') ? name.slice(1, -1) : name] = direction?.toLowerCase() === 'desc' ? 'desc' : 'asc'
      })
      return keys
    } catch {
      return {}
    }
  }
}

export namespace SQLiteDriver {
  export interface Config {
    path: string
  }

  export const Config: z<Config> = z.object({
    path: z.string().role('path').required(),
  }).i18n({
    'en-US': enUS,
    'zh-CN': zhCN,
  })
}

export default SQLiteDriver
