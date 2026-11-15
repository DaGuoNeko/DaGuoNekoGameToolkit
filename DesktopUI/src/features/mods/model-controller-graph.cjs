const { validateControllers, animationsOf, transitionsOf } = require("../../../shared/animation-controller.cjs");

const cardWidth = 208, cardHeight = 112, columnStep = 288, rowStep = 224, margin = 96;

function controllerGraph(controller, order = []) {
  validateControllers({ "controller.animation.graph": controller });
  const names = Object.keys(controller.states);
  const initial = controller.initial_state || (controller.states.default ? "default" : names[0]);
  const columns = Math.min(3, names.length);
  const width = margin * 2 + columns * columnStep;
  const height = margin * 2 + Math.ceil(names.length / columns) * rowStep;
  const arranged = [...new Set([...order.filter(name => names.includes(name)), ...names])];
  const nodes = arranged.map((name, index) => ({
    name, x: margin + index % columns * columnStep, y: margin + Math.floor(index / columns) * rowStep,
    initial: name === initial, animations: animationsOf(controller.states[name]),
  }));
  const byName = new Map(nodes.map(node => [node.name, node]));
  const edges = nodes.flatMap(source => transitionsOf(controller.states[source.name]).map((row, index) => {
    const target = byName.get(row.state), lane = 20 + index * 8;
    const startX = source.x + cardWidth, startY = source.y + 16 + index * 12;
    const endX = target.x + 24 + index * 22, endY = target.y;
    const top = target.y - lane, bottom = source.y + cardHeight + lane;
    // 长边沿卡片间隔和画布外侧布线，避免穿过其他状态；每条转移独立保留编号。
    const route = source.y === target.y
      ? `M ${startX} ${startY} H ${startX + lane} V ${top} H ${endX} V ${endY}`
      : `M ${startX} ${startY} H ${startX + lane} V ${bottom} H ${width - lane} V ${top} H ${endX} V ${endY}`;
    return { from: source.name, to: row.state, condition: row.condition, index, path: route, labelX: startX + 10, labelY: startY };
  }));
  return { nodes, edges, width, height, cardWidth, cardHeight, columns };
}

function searchControllerGraph(graph, query) {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  return graph.nodes.flatMap(node => {
    const edges = graph.edges.filter(edge => edge.from === node.name), reasons = [];
    if (node.name.toLowerCase().includes(text)) reasons.push("名称");
    if (node.animations.some(name => name.toLowerCase().includes(text))) reasons.push("动画引用");
    if (edges.some(edge => edge.to.toLowerCase().includes(text))) reasons.push("转移目标");
    if (edges.some(edge => edge.condition.toLowerCase().includes(text))) reasons.push("转移条件");
    return reasons.length ? [{ name: node.name, reasons }] : [];
  });
}

module.exports = { controllerGraph, searchControllerGraph };
