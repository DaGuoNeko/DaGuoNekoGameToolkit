// Preserve executable sections verbatim; remove optional source/debug metadata.
export function stripWasmDebug(input) {
  const bytes = Buffer.from(input);
  if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
    throw Error("Invalid WebAssembly header");
  function number(at, end) {
    let value = 0;
    for (let i = 0; i < 5 && at < end; i++) {
      const byte = bytes[at++];
      value += (byte & 127) * 2 ** (i * 7);
      if (!(byte & 128)) {
        if (value > 0xffffffff) break;
        return { value, at };
      }
    }
    throw Error("Invalid WebAssembly section length");
  }
  const output = [bytes.subarray(0, 8)];
  for (let at = 8; at < bytes.length;) {
    const start = at,
      id = bytes[at++],
      length = number(at, bytes.length);
    const end = length.at + length.value;
    if (end > bytes.length) throw Error("Truncated WebAssembly section");
    let drop = false;
    if (id === 0) {
      const name = number(length.at, end);
      if (name.at + name.value > end)
        throw Error("Invalid WebAssembly custom section");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(name.at, name.at + name.value),
      );
      drop = text.startsWith(".debug_") || text === "sourceMappingURL";
    }
    if (!drop) output.push(bytes.subarray(start, end));
    at = end;
  }
  return Buffer.concat(output);
}
