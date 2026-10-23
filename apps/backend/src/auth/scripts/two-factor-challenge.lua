-- One step of a second-factor challenge, done atomically, so attempts by several backend processes are all counted
-- and no step brings back a challenge that another one ended.
--
-- KEYS[1] the challenge: a hash of userId, epoch, attempts and ceremony
-- KEYS[2] the user's credential epoch, raised when their password changes or their second factors are reset: a
--         challenge started before that (with the old password) can no longer finish
-- ARGV[1] "attempt" (counts an attempt and returns the ceremony) or "finish" (uses the challenge up)
-- ARGV[2] the user ID the challenge must belong to, ARGV[3] attempts a challenge allows
--
-- Returns {"OK", ceremony} for an attempt, {"OK"} for a finish, or {"EXPIRED"} / {"TOO_MANY"}.

local challenge = redis.call("HMGET", KEYS[1], "userId", "epoch", "ceremony")
if challenge[1] ~= ARGV[2] then
  return {"EXPIRED"}
end
if (challenge[2] or "0") ~= (redis.call("GET", KEYS[2]) or "0") then
  redis.call("DEL", KEYS[1])
  return {"EXPIRED"}
end

if ARGV[1] == "finish" then
  redis.call("DEL", KEYS[1])
  return {"OK"}
end

if redis.call("HINCRBY", KEYS[1], "attempts", 1) > tonumber(ARGV[3]) then
  redis.call("DEL", KEYS[1])
  return {"TOO_MANY"}
end
return {"OK", challenge[3]}
