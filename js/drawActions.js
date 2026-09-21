/*
 * @Author: xubingchao
 * @Date: 2026-09-15 13:43:12
 * @LastEditors: xubingchao
 * @LastEditTime: 2026-09-21 10:02:28
 * @FilePath: \cesium-draw\js\drawActions.js
 */
/**
 * 开始绘制：根据 gui 传入的绘制类型，判断调用对应的绘制方法
 * @param {object} draw - Draw 实例（js/drawTool.js）
 * @param {string} type - 绘制类型："line" / "point" / "rect" / "polygon" / "circle" / "ellipse"
 */
export function startDraw(draw, type) {
  draw
    // 贴地
    // .startDraw({ type, style: { color: "#0092ff", clampToGround: true } })
    // 不贴地
    .startDraw({ type, style: { color: "#0092ff" } })
    .then((result) => console.log("绘制完成", result));
}

/**
 * 清除：移除地图上所有实体并销毁当前绘制状态
 * @param {object} draw - Draw 实例（js/drawTool.js）
 */
export function clear(draw) {
  draw.clear();
}

/**
 * 停止绘制：停止当前绘制并删除未完成的实体
 * @param {object} draw - Draw 实例（js/drawTool.js）
 */
export function stopDraw(draw) {
  draw.stopDraw();
}

/**
 * 清除正在绘制的对象，重新开始绘制（不退出绘制状态）
 * @param {object} draw - Draw 实例（js/drawTool.js）
 */
export function clearDrawing(draw) {
  draw.clearDrawing();
}
