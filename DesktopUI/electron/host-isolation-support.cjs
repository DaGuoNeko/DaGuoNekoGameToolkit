const { profileForDigest, profilesForDiscovery } = require("./domains/client/engine-profiles.cjs");
// 各项能力分别验收；自动入房兼容不代表已支持主机或来宾隔离。
const isolatedGameVersions = profilesForDiscovery()
  .filter(profile => profile.isolatedHost === true)
  .map(profile => profile.version);
function isolatedEngineVersion(hash) {
  const profile = profileForDigest(hash);
  return profile?.isolatedHost === true ? profile.version : null;
}
function isolatedClientEngineVersion(hash) {
  const profile = profileForDigest(hash);
  return profile?.isolatedClient === true ? profile.version : null;
}
function unsupportedGameReason(file) {
  const folder = require("node:path").basename(
    require("node:path").dirname(file),
  );
  const label = /^\d+(?:\.\d+){3}$/.test(folder)
    ? `（目录版本 ${folder}）`
    : "";
  return `当前游戏程序${label}尚未适配独立主机；已支持 ${isolatedGameVersions.join("、")}，同版本文件也必须通过构建校验`;
}
module.exports = {
  isolatedGameVersions,
  isolatedEngineVersion,
  isolatedClientEngineVersion,
  unsupportedGameReason,
};
