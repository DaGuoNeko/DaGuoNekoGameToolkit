const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function timelineTimeAt(pixel, width, length) {
  if (![pixel, width, length].every(Number.isFinite) || width <= 12 || length <= 0) return 0;
  const max = Math.floor(length * 20 + 1e-6) / 20;
  return clamp(Math.round((pixel - 6) / (width - 12) * length * 20) / 20, 0, max);
}

function timelineTicks(length, width, scroll = 0, viewport = width) {
  if (![length, width, scroll, viewport].every(Number.isFinite) || length <= 0 || width <= 12 || viewport <= 0) return [];
  const scale = (width - 12) / length, desired = 64 / scale;
  const power = 10 ** Math.floor(Math.log10(desired));
  const step = Math.max(0.05, [1, 2, 5, 10].find(value => value * power >= desired) * power);
  const first = Math.max(0, Math.floor((scroll - 6) / scale / step));
  const last = Math.min(Math.floor(length / step + 1e-9), Math.ceil((scroll + viewport - 6) / scale / step));
  const result = [];
  for (let index = first; index <= last && result.length < 256; index++) {
    const time = Math.round(index * step * 1e6) / 1e6;
    result.push({ time, x: 6 + time * scale });
  }
  return result;
}

function neighboringTime(times, current, direction, length) {
  const valid = times.filter(at => Number.isFinite(at) && at >= 0 && at <= length);
  const candidates = valid.filter(at => direction < 0 ? at < current - 1e-6 : at > current + 1e-6);
  return candidates.length ? (direction < 0 ? Math.max(...candidates) : Math.min(...candidates)) : direction < 0 ? 0 : length;
}

module.exports = { timelineTimeAt, timelineTicks, neighboringTime };
