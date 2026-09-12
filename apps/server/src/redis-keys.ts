export const REDIS_KEYS = {
  pixels: "canvas:pixels",
  bounds: "canvas:bounds",
  seq: "canvas:seq",
  events: "canvas:events",
} as const;

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const EVENT_STREAM_MAXLEN = 10_000;

export function idempotencyKey(placementId: string): string {
  return `idempotency:placement:${placementId}`;
}

export const PLACE_PIXEL_LUA = `
local existing = redis.call('GET', KEYS[3])
if existing then
  return {'duplicate', existing}
end

local prev = redis.call('HGET', KEYS[1], ARGV[1])
if not prev then
  prev = '0'
end

redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
local seq = redis.call('INCR', KEYS[2])

local result = cjson.encode({
  seq = seq,
  x = tonumber(ARGV[5]),
  y = tonumber(ARGV[6]),
  color_index = tonumber(ARGV[2]),
  user_id = ARGV[4],
  placement_id = ARGV[3],
  prev_color_index = tonumber(prev)
})

redis.call('SET', KEYS[3], result, 'EX', tonumber(ARGV[7]))
local stream_id = redis.call('XADD', KEYS[4], 'MAXLEN', '~', ARGV[8], '*', 'seq', tostring(seq), 'payload', result)
return {'ok', result, stream_id, prev}
`;
