export function parseLrc(lyric) {
  const offset = Number(lyric.match(/\[offset:\s*(-?\d+)\s*\]/i)?.[1] || 0) / 1000;
  const timestamps = /\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g;
  const lines = new Map();
  const untimed = [];
  for (const line of lyric.split(/\r?\n/)) {
    const units = [...line.matchAll(timestamps)];
    const text = line.replace(timestamps, "").trim();
    if (!text || /^\[[\w]+:/.test(text)) continue;
    const clean = text.slice(0, 180);
    if (!units.length) untimed.push(clean);
    for (const [, minute, second, fraction = "0"] of units) {
      const time = Math.max(0, Number(minute)*60 + Number(second) + Number("0." + fraction) + offset);
      if (!lines.has(time)) lines.set(time, clean);
    }
  }
  if (!lines.size) return untimed.slice(0, 3).map(text => ({time:null, text}));
  return [...lines].sort(([a], [b]) => a - b).map(([time, text]) => ({time, text}));
}

export function lyricAt(lines, time) {
  if (!lines.length) return -1;
  if (lines[0].time === null) return 0;
  let low = 0, high = lines.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].time <= time + .04) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
