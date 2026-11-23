-- The waiting writer's token gives it preference over new readers and other writers.
local key_write_intent = KEYS[1]
local key_write_lock = KEYS[2]
-- Each member is a reader token. Its score is the absolute expiry in Redis milliseconds.
local key_readers = KEYS[3]

local time = redis.call("time")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if ARGV[1] == "read_check" then
  local expiry = redis.call("zscore", key_readers, ARGV[2])
  return expiry ~= false and tonumber(expiry) > now
elseif ARGV[1] == "write_check" then
  return redis.call("get", key_write_lock) == ARGV[2]
end
redis.call("zremrangebyscore", key_readers, "-inf", now)

local function expire_reader_set()
  -- A short lease must never shorten another reader's lease. Redis deletes the empty set itself.
  local last = redis.call("zrange", key_readers, -1, -1, "withscores")
  if last[2] then
    redis.call("pexpireat", key_readers, last[2])
  end
end

local function write_lock(token, expire)
  local value_write_intent = redis.call("get", key_write_intent)
  if value_write_intent ~= false and value_write_intent ~= token then
    return false
  end
  if redis.call("exists", key_readers, key_write_lock) > 0 then
    redis.call("set", key_write_intent, token, "PX", expire)
    return false
  end

  redis.call("del", key_write_intent)
  redis.call("set", key_write_lock, token, "PX", expire)
  return true
end

-- Unlock the write lock locked with the given token by this client
local function write_unlock(token)
  if redis.call("get", key_write_lock) == token then
    redis.call("del", key_write_lock)
    return true
  end

  return false
end

-- Reset expire time of the write lock locked with the given token by this client
local function write_refresh(token, expire)
  if redis.call("get", key_write_lock) == token then
    redis.call("pexpire", key_write_lock, expire)
    return true
  end

  return false
end

local function read_lock(token, expire)
  if redis.call("exists", key_write_intent, key_write_lock) > 0 then
    return false
  end
  redis.call("zadd", key_readers, now + expire, token)
  expire_reader_set()
  return true
end

local function read_unlock(token)
  if redis.call("zrem", key_readers, token) == 0 then
    return false
  end
  expire_reader_set()
  return true
end

local function read_refresh(token, expire)
  if not redis.call("zscore", key_readers, token) then
    return 0
  end
  redis.call("zadd", key_readers, now + expire, token)
  expire_reader_set()
  return 1
end

-- Handle commands from Redis client
if ARGV[1] == "write_lock" then
  return write_lock(ARGV[2], ARGV[3])
elseif ARGV[1] == "write_unlock" then
  return write_unlock(ARGV[2])
elseif ARGV[1] == "write_refresh" then
  return write_refresh(ARGV[2], ARGV[3])
elseif ARGV[1] == "read_lock" then
  return read_lock(ARGV[2], ARGV[3])
elseif ARGV[1] == "read_unlock" then
  return read_unlock(ARGV[2])
elseif ARGV[1] == "read_refresh" then
  return read_refresh(ARGV[2], ARGV[3])
end
