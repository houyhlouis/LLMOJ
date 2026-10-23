-- Checks an email verification code and, if it is right, uses it up, in one step: of any number of requests with
-- the same code, from any backend process, at most one gets "OK" (review N09).
--
-- KEYS[1] the code for one purpose and address: a hash of code, subject (the account it is for, or "") and failures
-- KEYS[2] wrong answers for this purpose and address in the current window, whichever code they were meant for
-- ARGV[1] the code given, ARGV[2] the subject, ARGV[3] wrong answers a code survives,
-- ARGV[4] wrong answers allowed per window, ARGV[5] the window in seconds
--
-- Returns "OK" (used up now), "WRONG" (wrong, expired, used, or for another account) or "LIMITED" (too many wrong
-- answers for this address recently; nothing was checked).

if tonumber(redis.call("GET", KEYS[2]) or "0") >= tonumber(ARGV[4]) then
  return "LIMITED"
end

local challenge = redis.call("HMGET", KEYS[1], "code", "subject")
if challenge[1] and challenge[1] == ARGV[1] and challenge[2] == ARGV[2] then
  redis.call("DEL", KEYS[1])
  return "OK"
end

if challenge[1] and redis.call("HINCRBY", KEYS[1], "failures", 1) >= tonumber(ARGV[3]) then
  redis.call("DEL", KEYS[1])
end
if redis.call("INCR", KEYS[2]) == 1 then
  redis.call("EXPIRE", KEYS[2], ARGV[5])
end
return "WRONG"
