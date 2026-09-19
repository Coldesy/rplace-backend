local current_usage = redis.call('GET', KEYS[1])

if current_usage and tonumber(current_usage) >= tonumber(ARGV[1]) then
    return {"err", "RATE_LIMITED", redis.call('TTL', KEYS[1])}
end

local is_duplicate = redis.call('SET', 'placement:' .. ARGV[6], '1', 'NX', 'EX', 86400)
if not is_duplicate then
    return {"ok", "DUPLICATE_IGNORED"}
end

-- Increment Usage & Set Cooldown TTL
local new_usage = redis.call('INCR', KEYS[1])
if new_usage == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
end

redis.call('BITFIELD', KEYS[2], 'SET', 'u4', ARGV[3], ARGV[4])

local seq_num = redis.call('INCR', KEYS[4])

redis.call('XADD', KEYS[3], '*', 'user_id', ARGV[5], 'offset', ARGV[3], 'color', ARGV[4], 'placement_id', ARGV[6], 'seq', seq_num)


return {"ok", "PLACED", "remaining", tonumber(ARGV[1]) - new_usage, "seq", seq_num}