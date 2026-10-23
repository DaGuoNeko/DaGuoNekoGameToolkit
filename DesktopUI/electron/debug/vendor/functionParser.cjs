// Adapted from Dofes/mcdev-tools a31d4a4514593c78745dded5cad19eab0d87fb4b (MIT).
// Original: src/debugFunctions/parser.ts; see licenses/MCDevTools-LICENSE.txt.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  buildDebugFunctionInvocation: () => buildDebugFunctionInvocation,
  discoverDebugFunctions: () => discoverDebugFunctions,
  parseTopLevelFunctions: () => parseTopLevelFunctions
});
module.exports = __toCommonJS(stdin_exports);
var path = __toESM(require("path"));
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
function discoverDebugFunctions(workspaceName, files) {
  const normalizedFiles = files.map((file) => ({
    relativePath: normalizeRelativePath(file.relativePath),
    content: file.content
  })).filter((file) => !hasQuModLibsDirectory(file.relativePath));
  const addonRoots = normalizedFiles.filter((file) => path.posix.basename(file.relativePath).toLowerCase() === "modmain.py").map((file) => path.posix.dirname(file.relativePath)).sort((left, right) => right.length - left.length);
  const functions = [];
  for (const file of normalizedFiles) {
    if (!file.relativePath.toLowerCase().endsWith(".py")) {
      continue;
    }
    const root = addonRoots.find((candidate) => isWithinRoot(file.relativePath, candidate));
    if (!root) {
      continue;
    }
    const modulePath = resolveModulePath(workspaceName, root, file.relativePath);
    if (!modulePath) {
      continue;
    }
    for (const parsed of parseTopLevelFunctions(file.content)) {
      functions.push({
        key: `${modulePath}:${parsed.name}`,
        modulePath,
        functionName: parsed.name,
        relativeFilePath: file.relativePath,
        line: parsed.line,
        parameters: parsed.parameters
      });
    }
  }
  return functions.sort(
    (left, right) => left.modulePath.localeCompare(right.modulePath) || left.line - right.line || left.functionName.localeCompare(right.functionName)
  );
}
function buildDebugFunctionInvocation(saved, runtimeArguments = {}) {
  if (!isModulePath(saved.modulePath) || !IDENTIFIER.test(saved.functionName)) {
    throw new Error("Invalid Python module or function name");
  }
  const args = [];
  const kwargs = {};
  for (const parameter of saved.parameters) {
    const config = saved.argumentConfigs[parameter.name] ?? {
      mode: parameter.required ? "required" : "optional",
      value: ""
    };
    const runtimeValue = runtimeArguments[parameter.name]?.trim() ?? "";
    const configured = config.mode === "fixed" ? config.value.trim() : config.mode === "required" ? runtimeValue : runtimeValue || config.value.trim();
    if (!configured) {
      if (config.mode === "required" || config.mode === "fixed") {
        throw new Error(`Missing required argument: ${parameter.name}`);
      }
      continue;
    }
    let value;
    try {
      value = JSON.parse(configured);
    } catch {
      throw new Error(`Argument ${parameter.name} must be valid JSON`);
    }
    if (parameter.kind === "varargs") {
      if (!Array.isArray(value)) {
        throw new Error(`Argument ${parameter.name} must be a JSON array`);
      }
      args.push(...value);
    } else if (parameter.kind === "kwargs") {
      if (!isPlainObject(value)) {
        throw new Error(`Argument ${parameter.name} must be a JSON object`);
      }
      Object.assign(kwargs, value);
    } else {
      kwargs[parameter.name] = value;
    }
  }
  const payloadLiteral = JSON.stringify(JSON.stringify({ args, kwargs }));
  const moduleLiteral = JSON.stringify(saved.modulePath);
  const functionLiteral = JSON.stringify(saved.functionName);
  return [
    "# -*- coding: utf-8 -*-",
    "import json",
    `__mcdev_payload = json.loads(${payloadLiteral})`,
    `__mcdev_kwargs = dict((str(__mcdev_key), __mcdev_value) for __mcdev_key, __mcdev_value in __mcdev_payload['kwargs'].items())`,
    `__mcdev_module = __import__(${moduleLiteral}, fromlist=['*'])`,
    `_result = getattr(__mcdev_module, ${functionLiteral})(*__mcdev_payload['args'], **__mcdev_kwargs)`,
    "del __mcdev_module",
    "del __mcdev_kwargs",
    "del __mcdev_payload"
  ].join("\n");
}
function parseTopLevelFunctions(content) {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const masked = maskPythonStringsAndComments(normalized);
  const result = [];
  const definition = /^def[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/gm;
  let match;
  while (match = definition.exec(masked)) {
    const openParen = definition.lastIndex - 1;
    const closeParen = findMatchingParen(masked, openParen);
    if (closeParen < 0) {
      continue;
    }
    const signature = normalized.slice(openParen + 1, closeParen);
    result.push({
      name: match[1],
      line: countLines(normalized, match.index),
      parameters: parseParameters(signature)
    });
    definition.lastIndex = closeParen + 1;
  }
  return result;
}
function resolveModulePath(workspaceName, root, filePath) {
  const rootName = root === "." ? workspaceName : path.posix.basename(root);
  const relativeToRoot = root === "." ? filePath : filePath.slice(root.length + 1);
  const withoutExtension = relativeToRoot.slice(0, -3);
  const relativeParts = withoutExtension.split("/").filter(Boolean);
  if (relativeParts[relativeParts.length - 1] === "__init__") {
    relativeParts.pop();
  }
  const parts = [rootName, ...relativeParts];
  return parts.length > 0 && parts.every((part) => IDENTIFIER.test(part)) ? parts.join(".") : void 0;
}
function parseParameters(signature) {
  const parameters = [];
  for (const rawParameter of splitTopLevel(signature, ",")) {
    const raw = rawParameter.trim();
    if (!raw) {
      continue;
    }
    if (raw.startsWith("**")) {
      const name2 = raw.slice(2).trim();
      if (IDENTIFIER.test(name2)) {
        parameters.push({ name: name2, kind: "kwargs", required: false });
      }
      continue;
    }
    if (raw.startsWith("*")) {
      const name2 = raw.slice(1).trim();
      if (IDENTIFIER.test(name2)) {
        parameters.push({ name: name2, kind: "varargs", required: false });
      }
      continue;
    }
    const equalIndex = findTopLevelCharacter(raw, "=");
    const name = (equalIndex < 0 ? raw : raw.slice(0, equalIndex)).trim();
    if (!IDENTIFIER.test(name)) {
      continue;
    }
    const defaultValue = equalIndex < 0 ? void 0 : raw.slice(equalIndex + 1).trim();
    parameters.push({
      name,
      kind: "value",
      required: equalIndex < 0,
      ...defaultValue ? { defaultValue } : {}
    });
  }
  return parameters;
}
function maskPythonStringsAndComments(source) {
  const chars = source.split("");
  let quote = "";
  let triple = false;
  let escaped = false;
  let comment = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (comment) {
      if (char === "\n") {
        comment = false;
      } else {
        chars[index] = " ";
      }
      continue;
    }
    if (quote) {
      if (char === "\n" && !triple) {
        quote = "";
        escaped = false;
        continue;
      }
      if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
        chars[index] = chars[index + 1] = chars[index + 2] = " ";
        index += 2;
        quote = "";
        triple = false;
        continue;
      }
      chars[index] = char === "\n" ? "\n" : " ";
      if (!triple && !escaped && char === quote) {
        quote = "";
      }
      escaped = !escaped && char === "\\";
      if (char !== "\\") {
        escaped = false;
      }
      continue;
    }
    if (char === "#") {
      chars[index] = " ";
      comment = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      triple = source.slice(index, index + 3) === char.repeat(3);
      chars[index] = " ";
      if (triple) {
        chars[index + 1] = chars[index + 2] = " ";
        index += 2;
      }
    }
  }
  return chars.join("");
}
function splitTopLevel(value, separator) {
  const masked = maskPythonStringsAndComments(value);
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if ("([{".includes(char)) {
      depth += 1;
    } else if (")]}".includes(char)) {
      depth = Math.max(0, depth - 1);
    } else if (char === separator && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}
function findTopLevelCharacter(value, target) {
  const masked = maskPythonStringsAndComments(value);
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if ("([{".includes(char)) {
      depth += 1;
    } else if (")]}".includes(char)) {
      depth = Math.max(0, depth - 1);
    } else if (char === target && depth === 0) {
      return index;
    }
  }
  return -1;
}
function findMatchingParen(masked, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    if (masked[index] === "(") {
      depth += 1;
    } else if (masked[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}
function normalizeRelativePath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}
function hasQuModLibsDirectory(relativePath) {
  const directoryParts = relativePath.split("/").slice(0, -1);
  return directoryParts.some((part) => part.toLowerCase() === "qumodlibs");
}
function isWithinRoot(filePath, root) {
  return root === "." || filePath === root || filePath.startsWith(`${root}/`);
}
function isModulePath(value) {
  return value.split(".").length > 0 && value.split(".").every((part) => IDENTIFIER.test(part));
}
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function countLines(value, end) {
  let line = 1;
  for (let index = 0; index < end; index += 1) {
    if (value.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildDebugFunctionInvocation,
  discoverDebugFunctions,
  parseTopLevelFunctions
});
