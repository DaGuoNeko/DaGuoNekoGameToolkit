const config = {
  repository: "DaGuoNeko/DaGuoNekoGameToolkit",
  // 公开的应用标识随源码同步；用户令牌和 Client Secret 不得写入此处。
  clientId: process.env.DGN_UPDATE_GITHUB_CLIENT_ID || "Ov23liJoM5RLAn7NruGb",
  scope:
    process.env.DGN_UPDATE_GITHUB_SCOPE === undefined
      ? "repo"
      : process.env.DGN_UPDATE_GITHUB_SCOPE,
};

module.exports = config;
