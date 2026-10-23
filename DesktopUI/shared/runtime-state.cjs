// Replies and pushed events may overlap or arrive after a newer snapshot.
// Epochs separate cleared/new sessions; IDs deduplicate overlapping log ranges.
function mergeRuntime(current, incoming) {
  if (!current) return { ...incoming, logs: unique(incoming.logs || []) };
  if (incoming.epoch < current.epoch) return current;
  const newer = incoming.revision >= current.revision;
  const logs =
    incoming.epoch > current.epoch
      ? incoming.logs || []
      : [...current.logs, ...(incoming.logs || [])];
  return { ...(newer ? incoming : current), logs: unique(logs) };
}
function unique(logs) {
  return [...new Map(logs.map((entry) => [entry.id, entry])).values()]
    .sort((a, b) => a.id - b.id)
    .slice(-2000);
}
module.exports = { mergeRuntime };
