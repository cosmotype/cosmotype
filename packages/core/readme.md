# minato

[![Codecov](https://img.shields.io/codecov/c/github/cordiverse/minato?style=flat-square)](https://codecov.io/gh/cordiverse/minato)
[![downloads](https://img.shields.io/npm/dm/minato?style=flat-square)](https://www.npmjs.com/package/minato)
[![npm](https://img.shields.io/npm/v/minato?style=flat-square)](https://www.npmjs.com/package/minato)
[![GitHub](https://img.shields.io/github/license/cordiverse/minato?style=flat-square)](https://github.com/cordiverse/minato/blob/master/LICENSE)

Type Driven Database Framework.

## Features

- **Compatibility.** Complete driver-independent. Supports many drivers with a unified API.
- **Powerful.** It can do everything that SQL can do, even though you are not using SQL drivers.
- **Well-typed.** Minato is written with TypeScript, and it provides top-level typing support.
- **Extensible.** Simultaneous accesss to different databases based on your needs.
- **Modern.** Perform all the operations with a JavaScript API or even in the browser with low code.

## Driver Supports

| Driver | Version | Notes |
| ------ | ------ | ----- |
| [Memory](https://github.com/cordiverse/minato/tree/master/packages/memory) | [![npm](https://img.shields.io/npm/v/@minatojs/driver-memory?style=flat-square)](https://www.npmjs.com/package/@minatojs/driver-memory) | In-memory driver support |
| [MongoDB](https://github.com/cordiverse/minato/tree/master/packages/mongo) | [![npm](https://img.shields.io/npm/v/@minatojs/driver-mongo?style=flat-square)](https://www.npmjs.com/package/@minatojs/driver-mongo) | |
| [MySQL](https://github.com/cordiverse/minato/tree/master/packages/mysql) | [![npm](https://img.shields.io/npm/v/@minatojs/driver-mysql?style=flat-square)](https://www.npmjs.com/package/@minatojs/driver-mysql) | MySQL 5.7+, MariaDB 10.5 |
| [PostgreSQL](https://github.com/cordiverse/minato/tree/master/packages/postgres) | [![npm](https://img.shields.io/npm/v/@minatojs/driver-postgres?style=flat-square)](https://www.npmjs.com/package/@minatojs/driver-postgres) | PostgreSQL 14+ |
| [SQLite](https://github.com/cordiverse/minato/tree/master/packages/sqlite) | [![npm](https://img.shields.io/npm/v/@minatojs/driver-sqlite?style=flat-square)](https://www.npmjs.com/package/@minatojs/driver-sqlite) | |

## Basic Usage

```ts
import Database from 'minato'
import MySQLDriver from '@minatojs/driver-mysql'

const database = new Database()

await database.connect(MySQLDriver, {
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: '',
  database: 'minato',
})
```

## Data Definition

```ts
database.extend('user', {
  id: 'number',
  name: 'string',
  age: 'number',
  money: { type: 'number', initial: 100 },
}, {
  primary: 'id',
  autoInc: true,
})
```

## Documentation

[Click here](https://koishi.chat/en-US/guide/database/) for more details.
