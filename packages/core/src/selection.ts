import { defineProperty, Dict, filterKeys, mapValues, omit } from 'cosmokit'
import { Driver } from './driver.ts'
import { Eval, executeEval, isAggrExpr, isEvalExpr } from './eval.ts'
import { Field, Model } from './model.ts'
import { Query } from './query.ts'
import { FlatKeys, FlatPick, Flatten, getCell, Keys, randomId, Row } from './utils.ts'
import { Type } from './type.ts'

declare module './eval.ts' {
  export namespace Eval {
    export interface Static {
      exec<S, T>(value: Executable<S, T>): Expr<T>
    }
  }
}

export type Direction = 'asc' | 'desc'

export interface Modifier {
  limit: number
  offset: number
  sort: [Eval.Expr, Direction][]
  group?: string[]
  having: Eval.Expr<boolean>
  fields?: Dict<Eval.Expr>
  optional: Dict<boolean>
}

namespace Executable {
  export type Action = 'get' | 'set' | 'remove' | 'create' | 'upsert' | 'eval'

  export interface Payload {
    type: Action
    table: string | Selection | Dict<Selection.Immutable>
    ref: string
    query: Query.Expr
    args: any[]
  }
}

const createRow = (ref: string, expr = {}, prefix = '', model?: Model, intermediate?: Eval.Expr) => new Proxy(expr, {
  get(target, key) {
    if (key === '$prefix') return prefix
    if (key === '$model') return model
    if (typeof key === 'symbol' || key in target || key.startsWith('$')) return Reflect.get(target, key)

    if (intermediate) {
      if (Type.isArray(expr?.[Type.kType]) && Number.isInteger(+key)) {
        return createRow(ref, Eval.get(expr as any, +key), '', model, Eval.get(expr as any, +key))
      } else {
        return createRow(ref, Eval.get(intermediate as any, `${prefix}${key}`), `${prefix}${key}.`, model, intermediate)
      }
    }

    let type: Type
    const field = model?.fields[prefix + key as string]
    if (Type.isArray(expr?.[Type.kType]) && Number.isInteger(+key)) {
      // indexing array
      type = Type.getInner(expr?.[Type.kType]) ?? Type.fromField('expr')
      return createRow(ref, Eval.get(expr as any, +key), '', model, Eval.get(expr as any, +key))
    } else if (Type.getInner(expr?.[Type.kType], key)) {
      // type may conatins object layout
      type = Type.getInner(expr?.[Type.kType], key)!
    } else if (field) {
      type = Type.fromField(field)
    } else if (Object.keys(model?.fields!).some(k => k.startsWith(`${prefix}${key}.`))) {
      type = Type.Object(Object.fromEntries(Object.entries(model?.fields!)
        .filter(([k]) => k.startsWith(`${prefix}${key}`))
        .map(([k, field]) => [k.slice(prefix.length + key.length + 1), Type.fromField(field!)])))
    } else {
      // unknown field inside json
      type = model?.getType(`${prefix}${key}`) ?? Type.fromField('expr')
    }

    const row = createRow(ref, Eval('', [ref, `${prefix}${key}`], type), `${prefix}${key}.`, model)
    if (!field && Object.keys(model?.fields!).some(k => k.startsWith(`${prefix}${key}.`))) {
      return createRow(ref, Eval.object(row), `${prefix}${key}.`, model)
    } else {
      return row
    }
  },
})

interface Executable extends Executable.Payload {}

class Executable<S = any, T = any> {
  public readonly row!: Row<S>
  public readonly model!: Model
  public readonly driver!: Driver

  constructor(driver: Driver, payload: Executable.Payload) {
    Object.assign(this, payload)
    defineProperty(this, 'driver', driver)
    defineProperty(this, 'model', driver.model(this.table))
    defineProperty(this, 'row', createRow(this.ref, Eval.object(createRow(this.ref, {}, '', this.model)), '', this.model))
  }

  protected isCallaback(query: any): query is Selection.Callback<S> {
    if (typeof query !== 'function') return false
    const fields = query(this.row)
    return isEvalExpr(omit(fields, ['$object']))
  }

  protected resolveQuery(query?: Query<S>): Query.Expr<S>
  protected resolveQuery(query: Query<S> = {}): any {
    if (typeof query === 'function') {
      const expr = query(this.row)
      return expr['$expr'] ? expr : isEvalExpr(expr) ? { $expr: expr } : expr
    }
    if (Array.isArray(query) || query instanceof RegExp || ['string', 'number', 'bigint'].includes(typeof query)) {
      const { primary } = this.model
      if (Array.isArray(primary)) {
        throw new TypeError('invalid shorthand for composite primary key')
      }
      return { [primary]: query }
    }
    return query
  }

  protected resolveField(field: FieldLike<S> | Eval.Expr): Eval.Expr {
    if (typeof field === 'string') {
      return this.row[field]
    } else if (typeof field === 'function') {
      return field(this.row)
    } else if (isEvalExpr(field)) {
      return field
    } else {
      throw new TypeError('invalid field definition')
    }
  }

  protected resolveFields(fields: string | string[] | Dict<FieldLike<S>> | FieldCallback) {
    if (typeof fields === 'function') fields = fields(this.row)
    if (typeof fields === 'string') fields = [fields]
    if (Array.isArray(fields)) {
      const modelFields = Object.keys(this.model.fields)
      const entries = fields.flatMap((key) => {
        if (this.model.fields[key]) return [[key, this.row[key]]]
        else if (modelFields.some(path => path.startsWith(key + '.'))) {
          return modelFields.filter(path => path.startsWith(key + '.')).map(path => [path, this.row[path]])
        }
        return [[key, key.split('.').reduce((row, k) => row[k], this.row)]]
      })
      return Object.fromEntries(entries)
    } else {
      const entries = Object.entries(fields).flatMap(([key, field]) => {
        if (key.startsWith('$')) return []
        const expr = this.resolveField(field)
        if (expr['$object'] && !Type.fromTerm(expr).ignoreNull) {
          return Object.entries(expr['$object']).map(([key2, expr2]) => [`${key}.${key2}`, expr2])
        }
        return [[key, expr]]
      })
      return Object.fromEntries(entries)
    }
  }

  async execute(): Promise<T> {
    await this.driver.database.prepared()
    await this.driver._ensureSession()
    return this.driver[this.type as any](this, ...this.args)
  }
}

type FieldLike<S = any> = FlatKeys<S> | Selection.Callback<S>

type FieldType<S, T extends FieldLike<S>> =
  | T extends FlatKeys<S> ? Flatten<S>[T]
  : T extends Selection.Callback<S> ? Eval<ReturnType<T>>
  : never

type FieldMap<S, M extends Dict<FieldLike<S>>> = {
  [K in keyof M]: FieldType<S, M[K]>
}

type FieldCallback<S = any, M extends Dict<Eval.Term<any>> = any> = (row: Row<S>) => M

type EvalMap<M extends Dict<Eval.Term<any>>> = {
  [K in keyof M]: Eval<M[K]>
}

export namespace Selection {
  export type Callback<S = any, T = any, A extends boolean = boolean> = (row: Row<S>) => Eval.Expr<T, A>

  export interface Immutable extends Executable, Executable.Payload {
    tables: Dict<Model>
  }

  export interface Mutable extends Executable, Executable.Payload {
    tables: Dict<Model>
    table: string
  }
}

export interface Selection extends Executable.Payload {
  args: [Modifier]
}

export class Selection<S = any> extends Executable<S, S[]> {
  public tables: Dict<Model> = {}

  constructor(driver: Driver<any>, table: string | Selection | Dict<Selection.Immutable>, query?: Query) {
    super(driver, {
      type: 'get',
      ref: randomId(),
      table,
      query: null as never,
      args: [{ sort: [], limit: Infinity, offset: 0, group: undefined, having: Eval.and(), optional: {} }],
    })
    this.tables[this.ref] = this.model
    this.query = this.resolveQuery(query)
    if (typeof table !== 'string') {
      Object.assign(this.tables, table.tables)
    }
  }

  where(query: Query<S>) {
    this.query.$and ||= []
    this.query.$and.push(this.resolveQuery(query))
    return this
  }

  limit(limit: number): this
  limit(offset: number, limit: number): this
  limit(...args: [number] | [number, number]) {
    if (args.length > 1) this.offset(args.shift()!)
    this.args[0].limit = args[0]
    return this
  }

  offset(offset: number) {
    this.args[0].offset = offset
    return this
  }

  orderBy(field: FieldLike<S>, direction: Direction = 'asc') {
    this.args[0].sort.push([this.resolveField(field), direction])
    return this
  }

  groupBy<K extends FlatKeys<S>>(fields: K | readonly K[], query?: Selection.Callback<S, boolean>): Selection<FlatPick<S, K>>
  groupBy<K extends FlatKeys<S>, U extends Dict<FieldLike<S>>>(
    fields: K | K[],
    extra?: U,
    query?: Selection.Callback<S, boolean>,
  ): Selection<FlatPick<S, K> & FieldMap<S, U>>

  groupBy<K extends FlatKeys<S>, U extends object>(
    fields: K | K[],
    extra?: FieldCallback<S, U>,
    query?: Selection.Callback<S, boolean>,
  ): Selection<FlatPick<S, K> & EvalMap<U>>

  groupBy<K extends Dict<FieldLike<S>>>(fields: K, query?: Selection.Callback<S, boolean>): Selection<FieldMap<S, K>>
  groupBy<K extends Dict<FieldLike<S>>, U extends Dict<FieldLike<S>>>(
    fields: K,
    extra?: U,
    query?: Selection.Callback<S, boolean>,
  ): Selection<FieldMap<S, K & U>>

  groupBy<K extends Dict<FieldLike<S>>, U extends object>(
    fields: K,
    extra?: FieldCallback<S, U>,
    query?: Selection.Callback<S, boolean>,
  ): Selection<FieldMap<S, K> & EvalMap<U>>

  groupBy(fields: any, ...args: any[]) {
    this.args[0].fields = this.resolveFields(fields)
    this.args[0].group = Object.keys(this.args[0].fields!)
    const extra = this.isCallaback(args[0]) ? undefined : args.shift()
    Object.assign(this.args[0].fields!, this.resolveFields(extra || {}))
    if (args[0]) this.having(args[0])
    return new Selection(this.driver, this)
  }

  having(query: Selection.Callback<S, boolean>) {
    this.args[0].having['$and'].push(this.resolveField(query))
    return this
  }

  project<K extends FlatKeys<S>>(fields: K | readonly K[]): Selection<FlatPick<S, K>>
  project<U extends Dict<FieldLike<S>>>(fields: U): Selection<FieldMap<S, U>>
  project<U extends object>(fields: FieldCallback<S, U>): Selection<EvalMap<U>>
  project(fields: Keys<S>[] | Dict<FieldLike<S>> | FieldCallback) {
    this.args[0].fields = this.resolveFields(fields)
    return new Selection(this.driver, this)
  }

  join<K extends string, U>(
    name: K,
    selection: Selection<U>,
    callback: (self: Row<S>, other: Row<U>) => Eval.Expr<boolean> = () => Eval.and(),
    optional: boolean = false,
  ): Selection<S & { [P in K]: U}> {
    const fields = Object.fromEntries(Object.entries(this.model.fields)
      .filter(([key, field]) => Field.available(field) && !key.startsWith(name + '.'))
      .map(([key]) => [key, (row) => getCell(row[this.ref], key)]))
    const joinFields = Object.fromEntries(Object.entries(selection.model.fields)
      .filter(([key, field]) => Field.available(field) || Field.available(this.model.fields[`${name}.${key}`]))
      .map(([key]) => [key,
        (row) => Field.available(this.model.fields[`${name}.${key}`]) ? getCell(row[this.ref], `${name}.${key}`) : getCell(row[name], key),
      ]))
    if (optional) {
      return this.driver.database
        .join({ [this.ref]: this as Selection, [name]: selection }, (t: any) => callback(t[this.ref], t[name]), { [this.ref]: false, [name]: true })
        .project({ ...fields, [name]: (row) => Eval.ignoreNull(Eval.object(mapValues(joinFields, x => x(row)))) }) as any
    } else {
      return this.driver.database
        .join({ [this.ref]: this as Selection, [name]: selection }, (t: any) => callback(t[this.ref], t[name]))
        .project({ ...fields, [name]: (row) => Eval.ignoreNull(Eval.object(mapValues(joinFields, x => x(row)))) }) as any
    }
  }

  _action(type: Executable.Action, ...args: any[]) {
    return new Executable(this.driver, { ...this, type, args })
  }

  evaluate<T>(callback: Selection.Callback<S, T, true>): Eval.Expr<T, true>
  evaluate<K extends Keys<S>>(field: K): Eval.Expr<S[K][], false>
  evaluate<K extends Keys<S>>(field: K[]): Eval.Expr<any[][], false>
  evaluate(): Eval.Expr<S[], boolean>
  evaluate(callback?: any): any {
    const selection = new Selection(this.driver, this)
    if (!callback) callback = (row: any) => Eval.array(Eval.object(row))
    const expr = Array.isArray(callback) ? Eval.select(...callback.map(x => this.resolveField(x))) : this.resolveField(callback)
    if (isAggrExpr(expr)) defineProperty(expr, Type.kType, Type.Array(Type.fromTerm(expr)))
    return Eval.exec(selection._action('eval', expr))
  }

  execute(): Promise<S[]>
  execute<K extends FlatKeys<S> = any>(cursor?: Driver.Cursor<K>): Promise<FlatPick<S, K>[]>
  execute<T>(callback: Selection.Callback<S, T, true>): Promise<T>
  async execute(cursor?: any) {
    if (typeof cursor === 'function') {
      const selection = new Selection(this.driver, this)
      return selection._action('eval', this.resolveField(cursor)).execute()
    }
    if (Array.isArray(cursor)) {
      cursor = { fields: cursor }
    } else if (!cursor) {
      cursor = {}
    }
    if (cursor.fields) this.project(cursor.fields)
    if (cursor.limit !== undefined) this.limit(cursor.limit)
    if (cursor.offset !== undefined) this.offset(cursor.offset)
    if (cursor.sort) {
      for (const field in cursor.sort) {
        this.orderBy(field as any, cursor.sort[field])
      }
    }
    const rows = await super.execute()
    if (!cursor.fields) return rows
    return rows.map((row) => {
      return filterKeys(row as any, key => {
        return (cursor.fields as string[]).some(k => k === key || k.startsWith(`${key}.`))
      })
    })
  }
}

export namespace Selection {
  export function is(sel: any): sel is Selection {
    return sel && !!sel.tables as any
  }
}

export function executeSort(data: any[], modifier: Modifier, name: string) {
  const { limit, offset, sort } = modifier

  // step 1: sort data
  data.sort((a, b) => {
    for (const [field, direction] of sort) {
      const sign = direction === 'asc' ? 1 : -1
      const x = executeEval({ [name]: a, _: a }, field)
      const y = executeEval({ [name]: b, _: b }, field)
      if (x < y) return -sign
      if (x > y) return sign
    }
    return 0
  })

  // step 2: truncate data
  return data.slice(offset, offset + limit)
}
