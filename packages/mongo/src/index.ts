import { BSONType, ClientSession, Collection, Db, IndexDescription, Long, MongoClient, MongoClientOptions, MongoError, ObjectId } from 'mongodb'
import { Binary, Dict, isNullable, makeArray, mapValues, noop, omit, pick, remove } from 'cosmokit'
import { Driver, Eval, executeUpdate, Field, hasSubquery, Query, RuntimeError, Selection, z } from 'minato'
import { URLSearchParams } from 'url'
import { Builder } from './builder'
import zhCN from './locales/zh-CN.yml'
import enUS from './locales/en-US.yml'

const tempKey = '__temp_minato_mongo__'

interface TableMeta {
  _id: string
  virtual?: boolean
  migrate?: boolean
  autoInc?: number
  fields?: string[]
}

export class MongoDriver extends Driver<MongoDriver.Config> {
  static name = 'mongo'

  public client!: MongoClient
  public db!: Db
  public mongo = this
  public version = 0

  private builder: Builder = new Builder(this, [])
  private session?: ClientSession
  private _replSet: boolean = true
  private _createTasks: Dict<Promise<void>> = {}

  private connectionStringFromConfig() {
    const {
      authDatabase,
      connectOptions,
      host = 'localhost',
      database,
      password,
      protocol = 'mongodb',
      port = protocol.includes('srv') ? null : 27017,
      username,
    } = this.config

    let mongourl = `${protocol}://`
    if (username) mongourl += `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
    mongourl += `${host}${port ? `:${port}` : ''}/${authDatabase || database}`
    if (connectOptions) {
      const params = new URLSearchParams(connectOptions)
      mongourl += `?${params}`
    }
    return mongourl
  }

  async start() {
    const url = this.config.uri || this.connectionStringFromConfig()
    this.client = await MongoClient.connect(url, pick(this.config, [
      'writeConcern',
    ]))
    this.db = this.client.db(this.config.database)

    this.db.admin().serverInfo().then((doc) => this.version = +doc.version.split('.')[0]).catch(noop)
    await this.client.withSession((session) => session.withTransaction(
      () => this.db.collection('_fields').findOne({}, { session }),
      { readPreference: 'primary' },
    )).catch(() => {
      this._replSet = false
      this.logger.warn(`MongoDB is currently running as standalone server, transaction is disabled.
      Convert to replicaSet to enable the feature.
      See https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/`)
    })

    this.define<ArrayBuffer, ArrayBuffer>({
      types: ['binary'],
      dump: value => isNullable(value) ? value : Buffer.from(value),
      load: (value: any) => isNullable(value) ? value : Binary.fromSource(value.buffer),
    })

    this.define<bigint, number | Long>({
      types: ['bigint'],
      dump: value => isNullable(value) ? value : value as any,
      load: value => isNullable(value) ? value : BigInt(value as any),
    })

    this.define<ObjectId | string, ObjectId>({
      types: ['primary' as any],
      dump: value => typeof value === 'string' ? new ObjectId(value) : value,
      load: value => value,
    })
  }

  stop() {
    return this.client?.close()
  }

  /**
   * https://www.mongodb.com/docs/manual/indexes/
   */
  private async _createIndexes(table: string) {
    const { fields, primary, unique } = this.model(table)
    const coll = this.db.collection(table)
    const newSpecs: IndexDescription[] = []
    const oldSpecs = await coll.indexes()

    ;[primary, ...unique].forEach((keys, index) => {
      // use internal `_id` for single primary fields
      if (primary === keys && !index && this.getVirtualKey(table)) return

      // if the index is already created, skip it
      keys = makeArray(keys)
      const name = (index ? 'unique:' : 'primary:') + keys.join('+')
      if (oldSpecs.find(spec => spec.name === name)) return

      const nullable = Object.entries(fields).filter(([key]) => keys.includes(key)).every(([, field]) => field?.nullable)
      newSpecs.push({
        name,
        key: Object.fromEntries(keys.map(key => [key, 1])),
        unique: true,
        // https://www.mongodb.com/docs/manual/core/index-partial/#partial-indexes
        // mongodb seems to not support $ne in partialFilterExpression
        // so we cannot simply use `{ $ne: null }` to filter out null values
        // below is a workaround for https://github.com/koishijs/koishi/issues/893
        ...(nullable || index > unique.length) ? {} : {
          partialFilterExpression: Object.fromEntries(keys.map((key) => [key, {
            $type: [BSONType.date, BSONType.int, BSONType.long, BSONType.string, BSONType.objectId],
          }])),
        },
      })
    })

    if (!newSpecs.length) return
    await coll.createIndexes(newSpecs)
  }

  private async _createFields(table: string) {
    const { fields } = this.model(table)
    const coll = this.db.collection(table)
    const bulk = coll.initializeOrderedBulkOp()
    const virtualKey = this.getVirtualKey(table)
    const metaTable = this.db.collection<TableMeta>('_fields')
    const meta = { _id: table }, found = await metaTable.findOne(meta)
    if (!found?.fields) {
      this.logger.info('initializing fields for table %s', table)
      await metaTable.updateOne(meta, { $set: { fields: Object.keys(fields) } }, { upsert: true })
      return
    }
    for (const key in fields) {
      if (virtualKey === key) continue
      const { initial, legacy = [] } = fields[key]!
      if (!Field.available(fields[key])) continue
      if (found.fields.includes(key)) continue
      this.logger.info('auto migrating field %s for table %s', key, table)

      const oldKey = found.fields.find(field => legacy.includes(field))
      if (oldKey) {
        remove(found.fields, oldKey)
        found.fields.push(key)
        bulk.find({ [oldKey]: { $exists: true } }).update({ $rename: { [oldKey]: key } })
      } else {
        found.fields.push(key)
        bulk.find({}).update({ $set: { [key]: initial ?? null } })
      }
    }
    if (bulk.batches.length) {
      await bulk.execute()
      await metaTable.updateOne(meta, { $set: { fields: found.fields } })
    }
  }

  private async _migrateVirtual(table: string) {
    const { primary, fields } = this.model(table)
    if (Array.isArray(primary)) return
    const metaTable = this.db.collection<TableMeta>('_fields')
    const meta = { _id: table }, found = await metaTable.findOne(meta)
    let virtual = !!found?.virtual
    const useVirtualKey = !!this.getVirtualKey(table)
    // If  _fields table was missing for any reason
    // Test the type of _id to get its possible preference
    if (!found) {
      const doc = await this.db.collection(table).findOne()
      if (doc) {
        virtual = typeof doc._id !== 'object' || (typeof primary === 'string' && fields[primary]?.deftype === 'primary')
      }
      if (!doc || virtual === useVirtualKey) {
        // Empty table or already configured
        await metaTable.updateOne(meta, { $set: { virtual: useVirtualKey } }, { upsert: true })
        this.logger.info('successfully reconfigured table %s', table)
        return
      }
    }
    if (virtual === useVirtualKey) return
    this.logger.info('start migrating table %s', table)

    if (found?.migrate && await this.db.listCollections({ name: '_migrate_' + table }).hasNext()) {
      this.logger.info('last time crashed, recover')
    } else {
      await this.db.dropCollection('_migrate_' + table).catch(noop)
      await this.db.collection(table).aggregate([
        { $addFields: { _temp_id: '$_id' } },
        { $unset: ['_id'] },
        { $addFields: useVirtualKey ? { _id: '$' + primary } : { [primary]: '$_temp_id' } },
        { $unset: ['_temp_id', ...useVirtualKey ? [primary] : []] },
        { $out: '_migrate_' + table },
      ]).toArray()
      await metaTable.updateOne(meta, { $set: { migrate: true } }, { upsert: true })
    }
    await this.db.dropCollection(table).catch(noop)
    await this.db.renameCollection('_migrate_' + table, table)
    await metaTable.updateOne(meta,
      { $set: { virtual: useVirtualKey, migrate: false } },
      { upsert: true },
    )
    this.logger.info('successfully migrated table %s', table)
  }

  private async _migratePrimary(table: string) {
    const { primary, autoInc } = this.model(table)
    if (Array.isArray(primary) || !autoInc) return
    const metaTable = this.db.collection<TableMeta>('_fields')
    const meta = { _id: table }, found = await metaTable.findOne(meta)
    if (!isNullable(found?.autoInc)) return

    const coll = this.db.collection(table)
    // Primary _id cannot be modified thus should always meet the requirements
    if (!this.getVirtualKey(table)) {
      const bulk = coll.initializeOrderedBulkOp()
      await coll.find().forEach((data) => {
        bulk
          .find({ [primary]: data[primary] })
          .update({ $set: { [primary]: +data[primary] } })
      })
      if (bulk.batches.length) await bulk.execute()
    }

    const [latest] = await coll.find().sort(this.getVirtualKey(table) ? '_id' : primary, -1).limit(1).toArray()
    await metaTable.updateOne(meta, {
      $set: { autoInc: latest ? +latest[this.getVirtualKey(table) ? '_id' : primary] : 0, virtual: !!this.getVirtualKey(table) },
    }, { upsert: true })
  }

  private _internalTableTask?: Promise<Collection<Document>>

  async _createInternalTable() {
    return this._internalTableTask ||= this.db.createCollection('_fields').catch(noop)
  }

  /** synchronize table schema */
  async prepare(table: string) {
    await Promise.all([
      this._createInternalTable(),
      this.db.createCollection(table).catch(noop),
    ])

    await this._migrateVirtual(table)
    await Promise.all([
      this._createIndexes(table),
      this._createFields(table),
      this._migratePrimary(table),
    ])

    const $unset = {}
    await this.migrate(table, {
      error: this.logger.warn,
      before: () => true,
      after: keys => keys.forEach(key => $unset[key] = ''),
      finalize: async () => {
        if (!Object.keys($unset).length) return
        const coll = this.db.collection(table)
        await coll.updateMany({}, { $unset })
      },
    })
  }

  async drop(table: string) {
    await this.db.collection<TableMeta>('_fields').deleteOne({ _id: table }, { session: this.session })
    await this.db.dropCollection(table, { session: this.session })
  }

  async dropAll() {
    await Promise.all([
      '_fields',
      ...Object.keys(this.database.tables),
    ].map(name => this.db.dropCollection(name, { session: this.session })))
  }

  private async _collStats() {
    const tables = Object.keys(this.database.tables)
    const entries = await Promise.all(tables.map(async (name) => {
      const coll = this.db.collection(name)
      const [{ storageStats: { count, size } }] = await coll.aggregate([{
        $collStats: { storageStats: {} },
      }], { session: this.session }).toArray()
      return [coll.collectionName, { count, size }] as const
    }))
    return Object.fromEntries(entries)
  }

  async stats() {
    // https://docs.mongodb.com/manual/reference/command/dbStats/#std-label-dbstats-output
    const [stats, tables] = await Promise.all([
      this.db.stats(),
      this._collStats(),
    ])
    // while mongodb's document above says that the `stats.totalSize` is the sum of
    // `stats.dataSize` and `stats.storageSize`, it's actually `undefined` in some cases
    // so we have to calculate it manually.
    const totalSize = stats.indexSize + stats.storageSize
    return { size: totalSize, tables }
  }

  public getVirtualKey(table: string) {
    const { primary, fields } = this.model(table)
    if (typeof primary === 'string' && (this.config.optimizeIndex || fields[primary]?.deftype === 'primary')) {
      return primary
    }
  }

  private patchVirtual(table: string, row: any) {
    const { primary, fields } = this.model(table)
    if (typeof primary === 'string' && (this.config.optimizeIndex || fields[primary]?.deftype === 'primary')) {
      row[primary] = row['_id']
      delete row['_id']
    }
    return row
  }

  private unpatchVirtual(table: string, row: any) {
    const { primary, fields } = this.model(table)
    if (typeof primary === 'string' && (this.config.optimizeIndex || fields[primary]?.deftype === 'primary')) {
      row['_id'] = row[primary]
      delete row[primary]
    }
    return row
  }

  private transformQuery(sel: Selection.Immutable, query: Query.Expr, table: string) {
    return new Builder(this, Object.keys(sel.tables), this.getVirtualKey(table)).query(sel, query)
  }

  async get(sel: Selection.Immutable) {
    const transformer = new Builder(this, Object.keys(sel.tables)).select(sel)
    if (!transformer) return []
    this.logPipeline(transformer.table, transformer.pipeline)
    return this.db
      .collection(transformer.table)
      .aggregate(transformer.pipeline, { allowDiskUse: true, session: this.session })
      .toArray().then(rows => rows.map(row => this.builder.load(row, sel.model)))
  }

  async eval(sel: Selection.Immutable, expr: Eval.Expr) {
    const transformer = new Builder(this, Object.keys(sel.tables)).select(sel)
    if (!transformer) return
    this.logPipeline(transformer.table, transformer.pipeline)
    const res = await this.db
      .collection(transformer.table)
      .aggregate(transformer.pipeline, { allowDiskUse: true, session: this.session })
      .toArray()
    return this.builder.load(res.length ? res[0][transformer.evalKey!] : transformer.aggrDefault, expr)
  }

  async set(sel: Selection.Mutable, update: {}) {
    const { query, table, model } = sel
    if (hasSubquery(sel.query) || Object.values(update).some(x => hasSubquery(x))) {
      const transformer = new Builder(this, Object.keys(sel.tables)).select(sel, update)!
      await this.db.collection(transformer.table)
        .aggregate(transformer.pipeline, { allowDiskUse: true, session: this.session })
        .toArray()
      return {} // result not available
    } else {
      const filter = this.transformQuery(sel, query, table)
      if (!filter) return {}
      const coll = this.db.collection(table)

      const transformer = new Builder(this, Object.keys(sel.tables), this.getVirtualKey(table), '$' + tempKey + '.')
      const $set = this.builder.formatUpdateAggr(model.getType(), mapValues(this.builder.dump(update, model),
        (value: any) => typeof value === 'string' && value.startsWith('$') ? { $literal: value } : transformer.eval(value)))
      const $unset = Object.entries($set)
        .filter(([_, value]) => typeof value === 'object')
        .map(([key, _]) => key)
      const preset = Object.fromEntries(transformer.walkedKeys.map(key => [tempKey + '.' + key, '$' + key]))

      const result = await coll.updateMany(filter, [
        ...transformer.walkedKeys.length ? [{ $set: preset }] : [],
        ...$unset.length ? [{ $unset }] : [],
        { $set },
        ...transformer.walkedKeys.length ? [{ $unset: [tempKey] }] : [],
      ], { session: this.session })
      return { matched: result.matchedCount, modified: result.modifiedCount }
    }
  }

  async remove(sel: Selection.Mutable) {
    const { query, table } = sel
    const filter = this.transformQuery(sel, query, table)
    if (!filter) return {}
    const result = await this.db.collection(table).deleteMany(filter, { session: this.session })
    return { matched: result.deletedCount, removed: result.deletedCount }
  }

  private shouldEnsurePrimary(table: string) {
    const model = this.model(table)
    const { primary, autoInc } = model
    return typeof primary === 'string' && autoInc && model.fields[primary]?.deftype !== 'primary'
  }

  private shouldFillPrimary(table: string) {
    const model = this.model(table)
    const { primary, autoInc } = model
    return typeof primary === 'string' && autoInc && model.fields[primary]?.deftype === 'primary'
  }

  private async ensurePrimary(table: string, data: any[]) {
    const model = this.model(table)
    const { primary, autoInc } = model
    if (typeof primary === 'string' && autoInc && model.fields[primary]?.deftype !== 'primary') {
      const missing = data.filter(item => !(primary in item))
      if (!missing.length) return
      const doc = await this.db.collection<TableMeta>('_fields').findOneAndUpdate(
        { _id: table },
        { $inc: { autoInc: missing.length } },
        { session: this.session, upsert: true },
      )
      for (let i = 1; i <= missing.length; i++) {
        missing[i - 1][primary] = (doc!.autoInc ?? 0) + i
      }
    }
  }

  async create(sel: Selection.Mutable, data: any) {
    const { table, model } = sel
    const lastTask = Promise.resolve(this._createTasks[table]).catch(noop)
    return this._createTasks[table] = lastTask.then(async () => {
      const coll = this.db.collection(table)
      await this.ensurePrimary(table, [data])

      try {
        const copy = this.unpatchVirtual(table, { ...this.builder.dump(data, model) })
        const insertedId = (await coll.insertOne(copy, { session: this.session })).insertedId
        if (this.shouldFillPrimary(table)) {
          return { ...data, [model.primary as string]: insertedId }
        } else return data
      } catch (err) {
        if (err instanceof MongoError && err.code === 11000) {
          throw new RuntimeError('duplicate-entry', err.message)
        }
        throw err
      }
    })
  }

  async upsert(sel: Selection.Mutable, data: any[], keys: string[]) {
    if (!data.length) return {}
    const { table, ref, model } = sel
    const coll = this.db.collection(table)

    // If ensure primary, we must figure out number of insertions
    if (this.shouldEnsurePrimary(table)) {
      const original = (await coll.find({
        $or: data.map((item) => {
          return this.transformQuery(sel, pick(item, keys), table)!
        }),
      }, { session: this.session }).toArray()).map(row => this.patchVirtual(table, row))

      const bulk = coll.initializeUnorderedBulkOp()
      const insertion: any[] = []
      for (const update of data) {
        const item = original.find(item => keys.every(key => item[key]?.valueOf() === update[key]?.valueOf()))
        if (item) {
          const updateFields = new Set(Object.keys(update).map(key => key.split('.', 1)[0]))
          const override = this.builder.dump(omit(pick(executeUpdate(item, update, ref), updateFields), keys), model)
          const query = this.transformQuery(sel, pick(item, keys), table)
          if (!query) continue
          bulk.find(query).updateOne({ $set: override })
        } else {
          insertion.push(update)
        }
      }
      await this.ensurePrimary(table, insertion)
      for (const update of insertion) {
        const copy = this.builder.dump(executeUpdate(model.create(), update, ref), model)
        bulk.insert(this.unpatchVirtual(table, copy))
      }
      const result = await bulk.execute({ session: this.session })
      return { inserted: result.insertedCount + result.upsertedCount, matched: result.matchedCount, modified: result.modifiedCount }
    } else {
      const bulk = coll.initializeUnorderedBulkOp()
      const initial = model.create()
      const hasInitial = !!Object.keys(initial).length

      for (const update of data) {
        const query = this.transformQuery(sel, pick(update, keys), table)!
        const transformer = new Builder(this, Object.keys(sel.tables), this.getVirtualKey(table), '$' + tempKey + '.')
        const $set = this.builder.formatUpdateAggr(model.getType(), mapValues(this.builder.dump(update, model),
          (value: any) => typeof value === 'string' && value.startsWith('$') ? { $literal: value } : transformer.eval(value)))
        const $unset = Object.entries($set)
          .filter(([_, value]) => typeof value === 'object')
          .map(([key, _]) => key)
        const preset = Object.fromEntries(transformer.walkedKeys.map(key => [tempKey + '.' + key, {
          $ifNull: ['$' + key, initial[key]],
        }]))

        bulk.find(query).upsert().updateOne([
          ...transformer.walkedKeys.length ? [{ $set: preset }] : [],
          ...hasInitial ? [{ $replaceRoot: { newRoot: { $mergeObjects: [initial, '$$ROOT'] } } }] : [],
          ...$unset.length ? [{ $unset }] : [],
          { $set },
          ...transformer.walkedKeys.length ? [{ $unset: [tempKey] }] : [],
        ])
      }
      const result = await bulk.execute({ session: this.session })
      return { inserted: result.insertedCount + result.upsertedCount, matched: result.matchedCount, modified: result.modifiedCount }
    }
  }

  async withTransaction(callback: (session: any) => Promise<void>) {
    if (this._replSet) {
      await this.client.withSession((session) => session.withTransaction(() => callback(session), { readPreference: 'primary' }))
    } else {
      await callback(undefined)
    }
  }

  async getIndexes(table: string) {
    const indexes = await this.db.collection(table).listIndexes().toArray()
    return indexes.map(({ name, key, unique }) => ({
      name,
      unique: !!unique,
      keys: mapValues(key, value => value === 1 ? 'asc' : value === -1 ? 'desc' : value),
    } as Driver.Index))
  }

  async createIndex(table: string, index: Driver.Index) {
    const keys = mapValues(index.keys, (value) => value === 'asc' ? 1 : value === 'desc' ? -1 : isNullable(value) ? 1 : value)
    const { fields } = this.model(table)
    const nullable = Object.keys(index.keys).every(key => fields[key]?.nullable)
    await this.db.collection(table).createIndex(keys, {
      name: index.name,
      unique: !!index.unique,
      ...nullable ? {} : {
        partialFilterExpression: Object.fromEntries(Object.keys(index.keys).map((key) => [key, {
          $type: [BSONType.date, BSONType.int, BSONType.long, BSONType.string, BSONType.objectId],
        }])),
      },
    })
  }

  async dropIndex(table: string, name: string) {
    await this.db.collection(table).dropIndex(name)
  }

  logPipeline(table: string, pipeline: any) {
    this.logger.debug('%s %s', table, JSON.stringify(pipeline, (_, value) => typeof value === 'bigint' ? `${value}n` : value))
  }
}

export namespace MongoDriver {
  export interface Config extends MongoClientOptions {
    username?: string
    password?: string
    protocol?: string
    host?: string
    port?: number
    /** database name */
    database?: string
    /** default auth database */
    authDatabase?: string
    connectOptions?: ConstructorParameters<typeof URLSearchParams>[0]
    /** connection string (will overwrite all configs except 'name') */
    uri?: string
    /**
     * store single primary key in `_id` field to enhance index performance
     * @default false
     */
    optimizeIndex?: boolean
  }

  export const Config: z<Config> = z.object({
    protocol: z.string().default('mongodb'),
    host: z.string().default('localhost'),
    port: z.natural().max(65535),
    username: z.string(),
    password: z.string().role('secret'),
    database: z.string().required(),
    authDatabase: z.string(),
    writeConcern: z.object({
      w: z.union([
        z.const(undefined),
        z.number().required(),
        z.const('majority').required(),
      ]),
      wtimeoutMS: z.number(),
      journal: z.boolean(),
    }),
  }).i18n({
    'en-US': enUS,
    'zh-CN': zhCN,
  })
}

export default MongoDriver
