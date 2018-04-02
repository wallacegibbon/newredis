const { Logger } = require("colourlogger")
const { inspect } = require("util")
const EventEmitter = require("events")

const RedisConnection = require("./conn")
const { ConnectionError } = require("./errors")


class RedisPoolEventEmitter extends EventEmitter {}


class RedisConnectionPool extends Logger {
  /**
   * Attribute `this.connections` is the "pool", it holds all redis connections.
   * And `this.emitter` give clients the ability to *wait* for connections.
   */
  constructor(config) {
    super("RedisConnectionPool")
    Object.assign(this, { queue: [], connections: [], size: 0, nolog: false })
    this.config = Object.assign({ connectionLimit: 10 }, config)

    const emitter = new RedisPoolEventEmitter()
    emitter.on("release", this.queueHandler.bind(this))
    this.emitter = emitter
  }

  /**
   * As this function is executed asynchronously, the `free` flag should be
   * checked again before giving the connection to waiter.
   *
   * @param {Number} idx - The index of connection in the pool.
   */
  queueHandler(idx) {
    this.trace(`Redis Connection(pool idx ${idx}) just got released`)
    this.trace(`queue size: ${this.queue.length}`)
    this.showPoolStatus()

    const conn = this.connections[idx]
    if (conn.free === false && conn.broken === false) {
      return
    }
    if (this.queue.length > 0) {
      conn.free = false
      this.queue.shift().res(conn)
    }
  }

  /**
   * When there is no free connection in pool, and the pool is not full, create
   * a new connection and put it into the pool.
   */
  async getConnection() {
    this.showPoolStatus()
    const conn = this.connections.find(x => x.free || x.broken)
    if (!conn && this.size < this.config.connectionLimit) {
      this.size += 1
      return await this.getNewConnection()
    } else {
      return await this.getOldConnection()
    }
  }

  /**
   * Create new PoolConnection object, push it into `this.connections`, then
   * return the PoolConnection object to caller.
   */
  async getNewConnection() {
    this.debug("Trying to get a new Connection")
    const connIdx = this.connections.length
    const conn = new PoolConnection(this.config, this, connIdx)
    this.trace("New connection created")

    if (this.nolog) {
      conn.disableLog()
    }
    this.connections.push(conn)
    this.trace("New connection pushed to pool")

    await conn.initialize()
    return conn
  }

  /**
   * Get available connection from `this.connections`. There are 2 situations:
   * 1. There are already free connections available, use it directly.
   * 2. No free connection yet, wait for others to release one, then use it.
   *
   * If the connection returned is broken(i.e. the redis server crashes),
   * create a new connection to replace the old one.
   *
   * After getting a connection, the `free` and `broken` flags will be set
   * to fasle immediately.
   */
  async getOldConnection() {
    this.debug("Trying to get a old Connection")
    var conn = this.connections.find(x => x.free || x.broken)
    if (!conn) {
      this.trace("Waiting for one connection to release...")
      conn = await this.waitForRelease()
    }
    this.trace(`Old connection got(pool idx ${conn.idx})`)

    conn.free = false
    if (conn.broken) {
      conn.broken = false
      await conn.repair()
    }

    return conn
  }

  /**
   * This is why clients can "block" until there are connections available.
   */
  waitForRelease() {
    return new Promise((res, rej) => this.queue.push({ res, rej }))
  }

  /**
   * Return connection pool status. (`broken` and `flag` of each connection)
   */
  inspectPool() {
    return this.connections.map(c => ({ broken: c.broken, free: c.free }))
  }

  /**
   * Print connection pool status.
   */
  showPoolStatus() {
    this.info(`Pool status: ${inspect(this.inspectPool())}`)
  }

  /**
   * Disable log and disable log of PoolConnection instances in pool.
   */
  disableLog() {
    super.disableLog()
    this.nolog = true
    this.connections.forEach(x => x.disableLog())
  }

  /**
   * May be useful in the future.
   */
  emptyQueue() {
    var r
    while (r = this.queue.shift()) {
      r.rej(new ConnectionError("No live TCP connection"))
    }
  }
}




class PoolConnection extends Logger {
  /**
   * PoolConnection Objects always work with RedisConnectionPool Object. It is
   * the object that RedisConnectionPool keeps in the "pool".
   *
   * By using PoolConnection instead of raw connections, client can use
   * `conn.release()` to return connection back to pool.
   */
  constructor(config, pool, idx) {
    super("PoolConnection")
    Object.assign(this, { config, pool, idx, broken: false, free: false })
  }

  /**
   * A PoolConnection object is never destroyed, it not the TCP connection,
   * but a object that holds the TCP connection.
   *
   */
  async initialize() {
    this.info(`Initializing connection at pool idx ${this.idx}`)
    this.conn = this.createRedisConnection()
    try {
      await this.conn.initialize()
    } catch (e) {
      this.handleExecuteError(e)
    }
  }

  /**
   * Reset broken flag, and re-initialize the redis connection(create new TCP
   * connection to Redis server).
   */
  async repair() {
    this.warn(`Replacing the broken connection(pool idx ${this.idx})`)
    await this.initialize()
  }

  /**
   * Create a new RedisConnection object and bind necessary events.
   *
   * The TCP's "end" event should be listened, because when the client wait
   * for connection, it will never receive "error" event.
   */
  createRedisConnection() {
    const conn = new RedisConnection(this.config)
    conn.disableLog()
    conn.bindEndEvent(() => this.handleServerBroken())
    return conn
  }

  /**
   * When the server broken, the PoolConnection should be released.
   */
  handleServerBroken() {
    this.debug(`Server sent an end event back(to pool idx ${this.idx})`)
    this.broken = true
    this.pool.emitter.emit("release", this.idx)
  }

  /**
   * This is the interface for executing redis command.
   * @param {string[]} command - An array like [ "hget", "userxx", "age" ].
   */
  async execute(command) {
    this.debug(`(pool idx ${this.idx}) executing: ${inspect(command)}`)
    try {
      return await this.conn.execute(command)
    } catch (e) {
      this.handleExecuteError(e)
    }
  }

  /**
   * This is the method client should call after finishing the query.
   */
  release() {
    this.debug(`Releasing connection(pool idx ${this.idx})`)
    this.free = true
    this.pool.emitter.emit("release", this.idx)
  }

  /**
   * For certain errors like TCP connection error, set `broken` flag to true.
   * The error will be throw again anyway.
   */
  handleExecuteError(e) {
    if (e.constructor === ConnectionError) {
      this.broken = true
      this.pool.emitter.emit("release", this.idx)
    }
    throw e
  }

  /**
   * Wrapper for RedisConnection's backToDefaultDb()
   */
  async backToDefaultDb() {
    try {
      return await this.conn.backToDefaultDb()
    } catch (e) {
      this.handleExecuteError(e)
    }
  }
}



module.exports = RedisConnectionPool

