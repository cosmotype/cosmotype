import { clone, deepEqual, defineProperty, filterKeys, isNullable, makeArray, mapValues, MaybeArray } from 'cosmokit'
import { Context } from 'cordis'
import { Eval, isEvalExpr, Update } from './eval.ts'
import { DeepPartial, FlatKeys, Flatten, isFlat, Keys, Row, unravel } from './utils.ts'
import { Type } from './type.ts'
import { Driver } from './driver.ts'
import { Query } from './query.ts'
import { Selection } from './selection.ts'
import { Create } from './database.ts'

const Primary = Symbol('minato.primary')
export type Primary = (string | number) & { [Primary]: true }

export namespace Relation {
  const Marker = Symbol('minato.relation')
  export type Marker = { [Marker]: true }

  export const Type = ['oneToOne', 'oneToMany', 'manyToOne', 'manyToMany'] as const
  export type Type = typeof Type[number]

  export interface Config<S extends any = any, T extends Keys<S> = Keys<S>, K extends string = string> {
    type: Type
    table: T
    references: Keys<S[T]>[]
    fields: K[]
    shared: Record<K, Keys<S[T]>>
    required: boolean
  }

  export interface Definition<K extends string = string> {
    type: 'oneToOne' | 'manyToOne' | 'manyToMany'
    table?: string
    target?: string
    references?: MaybeArray<string>
    fields?: MaybeArray<K>
    shared?: MaybeArray<K> | Partial<Record<K, string>>
  }

  export type Include<T, S> = boolean | {
    [P in keyof T]?: T[P] extends MaybeArray<infer U> | undefined ? U extends S ? Include<U, S> : (U extends (infer I)[] ? Query.Expr<I> : never) : never
  }

  export type SetExpr<S extends object = any> = ((row: Row<S>) => Update<S>) | {
    where: Query.Expr<Flatten<S>> | Selection.Callback<S, boolean>
    update: Row.Computed<S, Update<S>>
  }

  export interface Modifier<T extends object = any, S extends any = any> {
    $create?: MaybeArray<Create<T, S>>
    $upsert?: MaybeArray<DeepPartial<T>>
    $set?: MaybeArray<SetExpr<T>>
    $remove?: Query.Expr<Flatten<T>> | Selection.Callback<T, boolean>
    $connect?: Query.Expr<Flatten<T>> | Selection.Callback<T, boolean>
    $disconnect?: Query.Expr<Flatten<T>> | Selection.Callback<T, boolean>
  }

  export function buildAssociationTable(...tables: [string, string]) {
    return '_' + tables.sort().join('_')
  }

  export function buildAssociationKey(key: string, table: string) {
    return `${table}.${key}`
  }

  export function buildSharedKey(field: string, reference: string) {
    return [field, reference].sort().join('_')
  }

  export function parse(def: Definition, key: string, model: Model, relmodel: Model, subprimary?: boolean): [Config, Config] {
    const shared = !def.shared ? {}
      : typeof def.shared === 'string' ? { [def.shared]: def.shared }
        : Array.isArray(def.shared) ? Object.fromEntries(def.shared.map(x => [x, x]))
          : def.shared
    const fields = def.fields ?? ((subprimary || def.type === 'manyToOne'
      || (def.type === 'oneToOne' && (model.name === relmodel.name || !makeArray(relmodel.primary).every(key => !relmodel.fields[key]?.nullable))))
      ? makeArray(relmodel.primary).map(x => `${key}.${x}`) : model.primary)
    const relation: Config = {
      type: def.type,
      table: def.table ?? relmodel.name,
      fields: makeArray(fields),
      shared: shared as any,
      references: makeArray(def.references ?? relmodel.primary),
      required: def.type !== 'manyToOne' && model.name !== relmodel.name
        && makeArray(fields).every(key => !model.fields[key]?.nullable || makeArray(model.primary).includes(key)),
    }
    // remove shared keys from fields and references
    Object.entries(shared).forEach(([k, v]) => {
      relation.fields = relation.fields.filter(x => x !== k)
      relation.references = relation.references.filter(x => x !== v)
    })
    const inverse: Config = {
      type: relation.type === 'oneToMany' ? 'manyToOne'
        : relation.type === 'manyToOne' ? 'oneToMany'
          : relation.type,
      table: model.name,
      fields: relation.references,
      references: relation.fields,
      shared: Object.fromEntries(Object.entries(shared).map(([k, v]) => [v, k])),
      required: relation.type !== 'oneToMany'
        && relation.references.every(key => !relmodel.fields[key]?.nullable || makeArray(relmodel.primary).includes(key)),
    }
    if (inverse.required) relation.required = false
    return [relation, inverse]
  }
}

export interface Field<T = any> {
  type: Type<T>
  deftype?: Field.Type<T>
  length?: number
  nullable?: boolean
  initial?: T
  precision?: number
  scale?: number
  expr?: Eval.Expr
  legacy?: string[]
  deprecated?: boolean
  relation?: Relation.Config
  transformers?: Driver.Transformer[]
}

export namespace Field {
  export const number: Type[] = ['integer', 'unsigned', 'float', 'double', 'decimal']
  export const string: Type[] = ['char', 'string', 'text']
  export const boolean: Type[] = ['boolean']
  export const date: Type[] = ['timestamp', 'date', 'time']
  export const object: Type[] = ['list', 'json']

  export type Type<T = any> =
    | T extends Primary ? 'primary'
    : T extends number ? 'integer' | 'unsigned' | 'float' | 'double' | 'decimal'
    : T extends string ? 'char' | 'string' | 'text'
    : T extends boolean ? 'boolean'
    : T extends Date ? 'timestamp' | 'date' | 'time'
    : T extends ArrayBuffer ? 'binary'
    : T extends bigint ? 'bigint'
    : T extends unknown[] ? 'list' | 'json' | 'oneToMany' | 'manyToMany'
    : T extends object ? 'json' | 'oneToOne' | 'manyToOne'
    : 'expr'

  type Shorthand<S extends string> = S | `${S}(${any})`

  export type Object<T = any, N = any> = {
    type: 'object'
    inner?: Extension<T, N>
  } & Omit<Field<T>, 'type'>

  export type Array<T = any, N = any> = {
    type: 'array'
    inner?: Literal<T, N> | Definition<T, N> | Transform<T, any, N>
  } & Omit<Field<T[]>, 'type'>

  export type Transform<S = any, T = S, N = any> = {
    type: Type<T> | Keys<N, T> | NewType<T> | 'object' | 'array'
    dump: (value: S | null) => T | null | void
    load: (value: T | null) => S | null | void
    initial?: S
  } & Omit<Definition<T, N>, 'type' | 'initial'>

  export type Definition<T, N> =
    | (Omit<Field<T>, 'type'> & { type: Type<T> | Keys<N, T> | NewType<T> })
    | (T extends object ? Object<T, N> : never)
    | (T extends (infer I)[] ? Array<I, N> : never)

  export type Literal<T, N> =
    | Shorthand<Type<T>>
    | Keys<N, T>
    | NewType<T>
    | (T extends object ? 'object' : never)
    | (T extends unknown[] ? 'array' : never)

  export type Parsable<T = any> = {
    type: Type<T> | Field<T>['type']
  } & Omit<Field<T>, 'type'>

  type MapField<O = any, N = any> = {
    [K in keyof O]?:
      | Literal<O[K], N>
      | Definition<O[K], N>
      | Transform<O[K], any, N>
      | (O[K] extends object | undefined ? Relation.Definition<FlatKeys<O>> : never)
  }

  export type Extension<O = any, N = any> = MapField<Flatten<O>, N>

  const NewType = Symbol('minato.newtype')
  export type NewType<T> = string & { [NewType]: T }

  export type Config<O = any> = {
    [K in keyof O]?: Field<O[K]>
  }

  const regexp = /^(\w+)(?:\((.+)\))?$/

  export function parse(source: string | Parsable): Field {
    if (typeof source === 'function') throw new TypeError('view field is not supported')
    if (typeof source !== 'string') {
      return {
        initial: null,
        deftype: source.type as any,
        ...source,
        type: Type.fromField(source.type),
      }
    }

    // parse string definition
    const capture = regexp.exec(source)
    if (!capture) throw new TypeError('invalid field definition')
    const type = capture[1] as Type
    const args = (capture[2] || '').split(',')
    const field: Field = { deftype: type, type: Type.fromField(type) }

    // set default initial value
    if (field.initial === undefined) field.initial = getInitial(type)

    // set length information
    if (type === 'decimal') {
      field.precision = +args[0]
      field.scale = +args[1]
    } else if (args[0]) {
      field.length = +args[0]
    }

    return field
  }

  export function getInitial(type: Field.Type, initial?: any) {
    if (initial === undefined) {
      if (Field.number.includes(type)) return 0
      if (Field.string.includes(type)) return ''
      if (type === 'list') return []
      if (type === 'json') return {}
    }
    return initial
  }

  export function available(field?: Field) {
    return !!field && !field.deprecated && !field.relation && field.deftype !== 'expr'
  }
}

export namespace Model {
  export type Migration<D = any> = (database: D) => Promise<void>

  export interface Config<K extends string = string> {
    callback?: Migration
    autoInc: boolean
    primary: MaybeArray<K>
    unique: MaybeArray<K>[]
    indexes: (MaybeArray<K> | Driver.IndexDef<K>)[]
    foreign: {
      [P in K]?: [string, string]
    }
  }
}

export interface Model extends Model.Config {}

export class Model<S = any> {
  declare ctx?: Context
  declare indexes: Driver.Index<FlatKeys<S>>[]
  fields: Field.Config<S> = {}
  migrations = new Map<Model.Migration, string[]>()

  declare private type: Type<S> | undefined

  constructor(public name: string) {
    this.autoInc = false
    this.primary = 'id' as never
    this.unique = []
    this.indexes = []
    this.foreign = {}
  }

  extend(fields: Field.Extension<S>, config?: Partial<Model.Config>): void
  extend(fields = {}, config: Partial<Model.Config> = {}) {
    const { primary, autoInc, unique = [], indexes = [], foreign, callback } = config

    this.primary = primary || this.primary
    this.autoInc = autoInc || this.autoInc
    unique.forEach(key => this.unique.includes(key) || this.unique.push(key))
    indexes.map(x => this.parseIndex(x)).forEach(index => (this.indexes.some(ind => deepEqual(ind, index))) || this.indexes.push(index))
    Object.assign(this.foreign, foreign)

    if (callback) this.migrations.set(callback, Object.keys(fields))

    for (const key in fields) {
      this.fields[key] = Field.parse(fields[key])
      this.fields[key].deprecated = !!callback
    }

    if (typeof this.primary === 'string' && this.fields[this.primary]?.deftype === 'primary') {
      this.autoInc = true
    }

    // check index
    this.checkIndex(this.primary)
    this.unique.forEach(index => this.checkIndex(index))
    this.indexes.forEach(index => this.checkIndex(index))
  }

  private parseIndex(index: MaybeArray<string> | Driver.Index): Driver.Index {
    if (typeof index === 'string' || Array.isArray(index)) {
      return {
        name: `index:${this.name}:` + makeArray(index).join('+'),
        unique: false,
        keys: Object.fromEntries(makeArray(index).map(key => [key, 'asc'])),
      }
    } else {
      return {
        name: index.name ?? `index:${this.name}:` + Object.keys(index.keys).join('+'),
        unique: index.unique ?? false,
        keys: index.keys,
      }
    }
  }

  private checkIndex(index: MaybeArray<string> | Driver.Index) {
    for (const key of typeof index === 'string' || Array.isArray(index) ? makeArray(index) : Object.keys(index.keys)) {
      if (!this.fields[key]) {
        throw new TypeError(`missing field definition for index key "${key}"`)
      }
    }
  }

  resolveValue(field: string | Field | Type, value: any) {
    if (isNullable(value)) return value
    if (typeof field === 'string') field = this.fields[field] as Field
    if (field) field = Type.fromField(field)
    if (field?.type === 'time') {
      const date = new Date(0)
      date.setHours(value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds())
      return date
    } else if (field?.type === 'date') {
      const date = new Date(value)
      date.setHours(0, 0, 0, 0)
      return date
    }
    return value
  }

  resolveModel(obj: any, model?: Type) {
    if (!model) model = this.getType()
    if (isNullable(obj) || !model.inner) return obj
    if (Type.isArray(model) && Array.isArray(obj)) {
      return obj.map(x => this.resolveModel(x, Type.getInner(model)!))
    }

    const result = {}
    for (const key in obj) {
      const type = Type.getInner(model, key)
      if (!type || isNullable(obj[key])) {
        result[key] = obj[key]
      } else if (type.type !== 'json') {
        result[key] = this.resolveValue(type, obj[key])
      } else if (isEvalExpr(obj[key])) {
        result[key] = obj[key]
      } else if (type.inner && Type.isArray(type) && Array.isArray(obj[key])) {
        result[key] = obj[key].map(x => this.resolveModel(x, Type.getInner(type)))
      } else if (type.inner) {
        result[key] = this.resolveModel(obj[key], type)
      } else {
        result[key] = obj[key]
      }
    }
    return result
  }

  format(source: object, strict = true, prefix = '', result = {} as S) {
    const fields = Object.keys(this.fields).filter(key => !this.fields[key].relation)
    Object.entries(source).map(([key, value]) => {
      key = prefix + key
      if (value === undefined) return
      if (fields.includes(key)) {
        result[key] = value
        return
      }
      const field = fields.find(field => key.startsWith(field + '.'))
      if (field) {
        result[key] = value
      } else if (isFlat(value)) {
        if (strict && (typeof value !== 'object' || Object.keys(value).length)) {
          throw new TypeError(`unknown field "${key}" in model ${this.name}`)
        }
      } else {
        this.format(value, strict, key + '.', result)
      }
    })
    return (strict && prefix === '') ? this.resolveModel(result) : result
  }

  parse(source: object, strict = true, prefix = '', result = {} as S) {
    const fields = Object.keys(this.fields).filter(key => !this.fields[key].relation)
    if (strict && prefix === '') {
      // initialize object layout
      Object.assign(result as any, unravel(Object.fromEntries(fields
        .filter(key => key.includes('.'))
        .map(key => [key.slice(0, key.lastIndexOf('.')), {}])),
      ))
    }
    for (const key in source) {
      let node = result
      const segments = key.split('.').reverse()
      for (let index = segments.length - 1; index > 0; index--) {
        const segment = segments[index]
        node = node[segment] ??= {}
      }
      if (key in source) {
        const fullKey = prefix + key, value = source[key]
        const field = fields.find(field => fullKey === field || fullKey.startsWith(field + '.'))
        if (field) {
          node[segments[0]] = value
        } else if (isFlat(value)) {
          if (strict) {
            throw new TypeError(`unknown field "${fullKey}" in model ${this.name}`)
          } else {
            node[segments[0]] = value
          }
        } else {
          this.parse(value, strict, fullKey + '.', node[segments[0]] ??= {})
        }
      }
    }
    return (strict && prefix === '') ? this.resolveModel(result) : result
  }

  create(data?: {}) {
    const result = {} as S
    const keys = makeArray(this.primary)
    for (const key in this.fields) {
      if (!Field.available(this.fields[key])) continue
      const { initial } = this.fields[key]!
      if (!keys.includes(key) && !isNullable(initial)) {
        result[key] = clone(initial)
      }
    }
    return this.parse({ ...result, ...data })
  }

  avaiableFields() {
    return filterKeys(this.fields, (_, field) => Field.available(field))
  }

  getType(): Type<S>
  getType(key: string): Type | undefined
  getType(key?: string): Type | undefined {
    if (!this.type) defineProperty(this, 'type', Type.Object(mapValues(this.fields, field => Type.fromField(field!))) as any)
    return key ? Type.getInner(this.type, key) : this.type
  }
}
