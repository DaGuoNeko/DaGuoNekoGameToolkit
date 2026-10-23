const LIBRARY_NAME = "DaGuoNekoGameToolkit";
const ID = /^w_[a-f0-9]{32}$/;
function managedId(folder) {
  if (typeof folder !== "string") return null;
  const parts = folder.split("/");
  return parts.length === 2 && parts[0] === LIBRARY_NAME && ID.test(parts[1])
    ? parts[1]
    : null;
}
const folderFor = (id) => `${LIBRARY_NAME}/${id}`;
module.exports = { LIBRARY_NAME, ID, managedId, folderFor };
