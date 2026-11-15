const {
  saveManifest, readGeometry, saveGeometry, listModels, createModel, deleteModel,
  listTextures, readTexture, saveTexture, createTexture, listAnimations, readAnimation,
  saveAnimation, createAnimation, deleteAnimation, renameAnimation, duplicateAnimation,
  listControllers, readController, saveController, createControllerFile,
} = require("./content-files.cjs");

async function resolveWorld(worlds, worldId) {
  if (!worldId) return null;
  if (!worlds) throw Error("当前实例不支持按存档读取内容");
  const record = worlds.find(await worlds.read(), null, worldId);
  const info = await worlds.inspect(record);
  if (info.deleted || !info.ready || !info.present) throw Error("存档尚未生成或已移除");
  return { record, root: info.path };
}

async function runContentCommand(method, args = {}, deps) {
  const { modLibrary, contentIndex, worlds, studioRoot } = deps;
  if (method === "content.scan") {
    const selected = await resolveWorld(worlds, args.worldId);
    if (!selected) return contentIndex.scan();
    return contentIndex.scan({
      root: selected.root,
      packId: args.packId,
      sourceId: selected.record.id,
      sourceName: selected.record.name,
    });
  }
  if (method === "content.list-models") return listModels(modLibrary, studioRoot);
  if (method === "content.create-model") return createModel(args, studioRoot);
  if (method === "content.delete-model") return deleteModel(modLibrary, args.path, studioRoot);
  const selected = await resolveWorld(worlds, args.worldId);
  const root = selected?.root || null;
  if (method === "content.create-texture") return createTexture(modLibrary, args, root, studioRoot);
  if (method === "content.list-textures") return listTextures(modLibrary, args.path, root, studioRoot);
  if (method === "content.read-texture") return readTexture(modLibrary, args.path, root, studioRoot);
  if (method === "content.save-texture") return saveTexture(modLibrary, args, root, studioRoot);
  if (method === "content.save-manifest") return saveManifest(modLibrary, args, root);
  if (method === "content.read-geometry") return readGeometry(modLibrary, args.path, root, studioRoot);
  if (method === "content.save-geometry") return saveGeometry(modLibrary, args, root, studioRoot);
  if (method === "content.list-animations") return listAnimations(modLibrary, args.path, root, studioRoot);
  if (method === "content.read-animation") return readAnimation(modLibrary, args.path, args.id, root, studioRoot);
  if (method === "content.save-animation") return saveAnimation(modLibrary, args, root, studioRoot);
  if (method === "content.create-animation") return createAnimation(modLibrary, args, root, studioRoot);
  if (method === "content.delete-animation") return deleteAnimation(modLibrary, args, root, studioRoot);
  if (method === "content.rename-animation") return renameAnimation(modLibrary, args, root, studioRoot);
  if (method === "content.duplicate-animation") return duplicateAnimation(modLibrary, args, root, studioRoot);
  if (method === "content.list-controllers") return listControllers(modLibrary, args.path, root, studioRoot);
  if (method === "content.read-controller") return readController(modLibrary, args.path, root, studioRoot);
  if (method === "content.save-controller") return saveController(modLibrary, args, root, studioRoot);
  if (method === "content.create-controller") return createControllerFile(modLibrary, args, root, studioRoot);
  throw Error("未知的内容操作");
}

module.exports = { resolveWorld, runContentCommand };
