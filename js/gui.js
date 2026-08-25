// 引入离线 lil-gui（ES Module，默认导出 GUI）
import GUI from "../libs/lil-gui.js";
// 引入绘制 / 清除 / 停止绘制 / 重新绘制方法
import { startDraw, clear, stopDraw, clearDrawing } from "./drawActions.js";

/**
 * 创建 lil-gui 工具面板：开始画线 / 清除
 * @param {object} draw - Draw 实例（js/drawTool.js）
 * @param {object} viewer - Cesium Viewer 实例
 * @param {object} [config] - 可选配置
 * @param {Function} [config.onCoordinates] - 画线完成后的回调（右键结束绘制时触发）
 * @param {string} [config.title] - 面板标题
 * @returns {GUI} lil-gui 面板实例
 */
export default function initGui(draw, viewer, config = {}) {
  const gui = new GUI({ title: config.title || "绘制工具" });
  // 面板定位到右上角
  gui.domElement.style.position = "absolute";
  gui.domElement.style.top = "10px";
  gui.domElement.style.right = "10px";
  gui.domElement.style.width = "120px";

  // 添加按钮：通过引入的 startDraw / clear / stopDraw 方法实现调用
  const params = {
    drawLine: () => startDraw(draw, "line"),
    drawPoint: () => startDraw(draw, "point"),
    drawRect: () => startDraw(draw, "rect"),
    drawPolygon: () => startDraw(draw, "polygon"),
    drawCircle: () => startDraw(draw, "circle"),
    drawEllipse: () => startDraw(draw, "ellipse"),
    stopDraw: () => stopDraw(draw),
    clearDrawing: () => clearDrawing(draw),
    clear: () => clear(draw),
  };
  gui.add(params, "drawPoint").name("点");
  gui.add(params, "drawLine").name("线");
  gui.add(params, "drawRect").name("矩形");
  gui.add(params, "drawPolygon").name("多边形");
  gui.add(params, "drawCircle").name("圆");
  gui.add(params, "drawEllipse").name("椭圆");
  gui.add(params, "stopDraw").name("停止绘制");
  gui.add(params, "clearDrawing").name("重新绘制");
  gui.add(params, "clear").name("清空图层");

  return gui;
}
