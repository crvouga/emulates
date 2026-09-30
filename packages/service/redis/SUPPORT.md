# Redis (Mockingbird subset) — command support

Work in progress. Replies are checked against the Redis command reference and local Redis 8.4.0
spot checks. The server reports `redis_version` 7.2.4 and `redis_mode:standalone`.

| area | commands | notes |
| --- | --- | --- |
| connection | `AUTH`, `HELLO`, `PING`, `QUIT`, `RESET`, `SELECT`, `CLIENT`, `INFO`, `ECHO` | RESP2 and RESP3. `HELLO 3` switches before its map reply. |
| strings | `GET`, `SET`, `MGET`, `MSET`, `INCR`, `DECR`, `APPEND`, `GETSET`, `GETDEL`, `GETEX` | `NX` `XX` `EX` `PX` `EXAT` `PXAT` `KEEPTTL` `GET`. |
| expiration | `EXPIRE`, `PEXPIRE`, `EXPIREAT`, `PEXPIREAT`, `TTL`, `PTTL`, `PERSIST` | Injected clock. Negative `EXPIRE` deletes an existing key. |
| keys | `DEL`, `EXISTS`, `TYPE`, `SCAN`, `KEYS`, `RENAME`, `FLUSHDB`, `FLUSHALL` | `SCAN` cursor is a bulk string. |
| hashes | `HSET`, `HGET`, `HMGET`, `HGETALL`, `HDEL`, `HINCRBY` | |
| lists | `LPUSH`, `RPUSH`, `LPOP`, `RPOP`, `LRANGE`, `LMOVE`, `BLPOP`, `BRPOP` | Blocking waits release the command queue. |
| sets | `SADD`, `SREM`, `SMEMBERS`, `SISMEMBER`, `SPOP` | Members are ordered bytewise. |
| sorted sets | `ZADD`, `ZRANGE`, `ZPOPMIN`, `BZPOPMIN`, `ZINCRBY` | Integer scores encode without a trailing `.0`. |
| streams | `XADD`, `XREAD`, `XGROUP`, `XREADGROUP`, `XACK`, `XPENDING`, `XCLAIM`, `XAUTOCLAIM` | Consumer-group pending entries and claim. |
| transactions | `MULTI`, `EXEC`, `DISCARD`, `WATCH`, `UNWATCH` | A watched key change makes `EXEC` a null array. |
| pub/sub | `SUBSCRIBE`, `UNSUBSCRIBE`, `PSUBSCRIBE`, `PUBLISH`, `PUBSUB` | |
| scripts | `EVAL`, `EVALSHA`, `SCRIPT LOAD`, `SCRIPT EXISTS`, `SCRIPT FLUSH` | Lua subset plus `cjson`. No `cmsgpack`. |
| cluster | `CLUSTER`, `READONLY`, `ASKING` | Single node: cluster support disabled. |

Out of scope for this pass: Redis Cluster, Redis 8 modules, a complete Lua 5.1 runtime, and full
BullMQ compatibility.
