const config = {
  repository: "DaGuoNeko/DaGuoNekoGameToolkit",
  feedUrl:
    process.env.DGN_UPDATE_FEED_URL ||
    "https://github.com/DaGuoNeko/DaGuoNekoGameToolkit/releases/latest/download/latest.json",
};

module.exports = config;
