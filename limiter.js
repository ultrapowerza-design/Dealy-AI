// Small in-memory rate limiter (per IP). Good enough for a single server instance.
// key: optional function (req) => string. Defaults to the visitor IP; use () => "all" for a global limit.
export function makeLimiter({ windowMs, max, message, key = (req) => req.ip }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of hits) {
      const fresh = times.filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(ip, fresh);
      else hits.delete(ip);
    }
  }, Math.min(windowMs, 60_000)).unref();

  return (req, res, next) => {
    const now = Date.now();
    const id = key(req);
    const times = (hits.get(id) ?? []).filter((t) => now - t < windowMs);

    if (times.length >= max) {
      res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: message });
    }

    times.push(now);
    hits.set(id, times);
    next();
  };
}
