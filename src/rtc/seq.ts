// Ordering stamp for broadcast signals (presence, "stream ended" bye). The same message goes out over several
// public brokers, and a slow one can deliver an old copy late: receivers drop anything older than what they already
// have from that member. Milliseconds since epoch, strictly increasing within this app run.

let last = 0

export function nextSeq(): number {
  last = Math.max(Date.now(), last + 1)
  return last
}
