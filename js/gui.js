// 引入离线 lil-gui（ES Module，默认导出 GUI）
import GUI from "../libs/lil-gui.js";
import DrawTool from "./drawTool.js";

const typeNames = {
  point: "点",
  line: "线",
  rect: "矩形",
  polygon: "多边形",
  circle: "圆",
  ellipse: "椭圆",
};
const eventNames = [
  "drawStart",
  "drawAddPoint",
  "drawRemovePoint",
  "drawEnd",
  "editStart",
  "editAddPoint",
  "editRemovePoint",
  "editMovePoint",
  "editStop",
  "removeGraphic",
];
// 每次调用返回新数据；省略 ID 演示自动生成，不覆盖已有图形。
const samples = () => [
  { type: "point", positions: [[108, 33]] },
  {
    type: "line",
    positions: [
      [109, 33],
      [111, 33],
    ],
  },
  {
    type: "rect",
    positions: [
      [112, 32],
      [114, 32],
      [114, 34],
      [112, 34],
    ],
  },
  {
    type: "polygon",
    positions: [
      [108, 29],
      [110, 29],
      [110, 31],
      [108.5, 30.5],
    ],
  },
  {
    type: "circle",
    positions: [
      [112, 30],
      [112.8, 30],
    ],
  },
  {
    type: "ellipse",
    positions: [
      [115, 30],
      [116.2, 30],
      [115, 30.5],
    ],
  },
];

/**
 * 创建功能演示面板；返回 GUI，gui.demo 提供同一组可编程用例。
 * @param {object} draw - Draw 实例（js/drawTool.js）
 * @param {object} viewer - Cesium Viewer 实例
 * @param {object} [config] - 可选配置
 * @param {Function} [config.onCoordinates] - 任意图形交互完成后的回调
 * @param {HTMLElement} [config.output] - 事件及操作日志容器
 * @param {HTMLTextAreaElement} [config.jsonEditor] - JSON 输入输出区域
 * @param {HTMLElement} [config.status] - 状态文字容器
 * @param {string} [config.title] - 面板标题
 * @returns {GUI} lil-gui 面板实例
 */
export default function initGui(draw, viewer, config = {}) {
  const gui = new GUI({
    title: config.title || "DrawTool 功能用例",
    width: 290,
  });
  Object.assign(gui.domElement.style, {
    position: "absolute",
    top: "10px",
    right: "10px",
    maxHeight: "calc(100vh - 20px)",
    overflowY: "auto",
  });
  let current = draw;
  let destroyed = false;
  let disposed = false;
  let recreating = false;
  let externalLayer = null;
  let selectedController;
  let lastSnapshot = null;
  let unbind = () => {};
  const logs = [];
  const state = {
    mode: "Promise",
    id: "",
    selected: "",
    sampleType: "point",
    vertexIndex: 0,
    ...draw.defaultStyle,
    enableEdit: draw.enableEdit,
    autoEdit: draw.autoEdit,
    layerVisible: true,
    eventLogging: true,
    requestRenderMode: viewer.scene.requestRenderMode,
    fps: false,
    menuTheme: false,
    layerMode: "自建图层",
  };
  const style = () => ({
    color: state.color,
    lineWidth: state.lineWidth,
    pointSize: state.pointSize,
    clampToGround: state.clampToGround,
  });
  function log(message, data) {
    if (disposed) return;
    logs.unshift(
      `${new Date().toLocaleTimeString()} ${message}${data === undefined ? "" : `\n${JSON.stringify(data, null, 2)}`}`,
    );
    logs.length = Math.min(logs.length, 60);
    if (config.output) config.output.textContent = logs.join("\n\n");
  }
  function refresh() {
    if (disposed) return;
    const records = current.getGraphics();
    if (!records.some((item) => item.id === state.selected))
      state.selected = records[0]?.id || "";
    const options = { "（请选择）": "" };
    records.forEach((item) => {
      options[`${typeNames[item.type]} · ${item.id}`] = item.id;
    });
    selectedController?.options(options).updateDisplay();
    if (config.status)
      config.status.textContent = destroyed
        ? "实例已销毁，请重建"
        : `${current.drawingShape ? `绘制 ${typeNames[current.drawingShape.type]}` : current.editing ? "编辑中" : "空闲"} · ${records.length} 个图形 · ${state.layerMode}`;
  }
  function alive() {
    if (destroyed || disposed) throw new Error("实例已销毁，请先重建实例");
  }
  // GUI 按钮统一捕获同步错误及 Promise 拒绝；控制台 API 仍返回真实结果/错误。
  const run = (action) => async () => {
    try {
      await action();
    } catch (error) {
      log(
        error.name === "AbortError"
          ? "绘制已取消"
          : `操作失败：${error.message}`,
      );
    } finally {
      refresh();
    }
  };
  function bind() {
    const owner = current;
    const handlers = eventNames.map((name) => {
      const handler = (data) => {
        if (name === "drawEnd" || name === "editStart")
          state.selected = data.id;
        if (state.eventLogging) log(name, data);
        refresh();
      };
      owner.on(name, handler);
      return [name, handler];
    });
    unbind = () =>
      handlers.forEach(([name, handler]) => owner.off(name, handler));
  }
  function selectedShape() {
    alive();
    // startEditing 接收内部 shape，不可传 getGraphic 返回的快照。
    const shape = current.shapes.find((item) => item.id === state.selected);
    if (!shape) throw new Error("请先选择一个已完成的图形");
    return shape;
  }
  function completed(result, owner) {
    if (owner !== current || disposed) return;
    lastSnapshot = structuredClone(result);
    state.selected = result.id;
    log("完成结果（独立快照）", result);
    refresh();
    return config.onCoordinates?.(result);
  }
  const demo = {
    get draw() {
      return current;
    },
    state,
    samples,
    async start(type, mode = state.mode) {
      alive();
      const owner = current;
      const options = {
        type,
        style: style(),
        ...(state.id.trim() ? { id: state.id.trim() } : {}),
      };
      if (mode !== "Promise") {
        options.success = (result) => completed(result, owner);
        if (mode === "类型方法") {
          const methods = {
            point: "drawPoint",
            line: "drawLine",
            rect: "drawRect",
            polygon: "drawPolygon",
            circle: "drawCircle",
            ellipse: "drawEllipse",
          };
          if (!methods[type]) throw new Error("不支持的图形类型");
          owner[methods[type]](options);
        } else owner.startDraw(options);
        refresh();
        return;
      }
      try {
        const pending = owner.startDraw(options);
        refresh();
        const result = await pending;
        await completed(result, owner);
        return result;
      } catch (error) {
        if (error.name !== "AbortError") throw error;
        log("Promise 已拒绝：AbortError（正常取消）");
        return null;
      }
    },
    stopDraw() {
      alive();
      current.stopDraw();
      refresh();
    },
    clearDrawing() {
      alive();
      if (!current.drawingShape) throw new Error("请先开始绘制");
      current.clearDrawing();
      refresh();
    },
    clear() {
      alive();
      current.clear();
      refresh();
    },
    startEditing() {
      const shape = selectedShape();
      if (!current.enableEdit) throw new Error("请先开启允许编辑");
      current.startEditing(shape);
      refresh();
    },
    stopEditing() {
      alive();
      current.stopEditing();
      refresh();
    },
    removeGraphic(id = state.selected) {
      alive();
      if (!current.getGraphic(id)) throw new Error("找不到该 ID");
      current.removeGraphic(id);
      refresh();
    },
    getGraphic(id = state.selected) {
      alive();
      const record = current.getGraphic(id);
      log("getGraphic", record);
      return record;
    },
    getGraphics() {
      alive();
      const records = current.getGraphics();
      log("getGraphics", records);
      return records;
    },
    addGraphic(data) {
      alive();
      const result = current.addGraphic(data);
      state.selected = result.id;
      refresh();
      log("静默新增", result);
      return result;
    },
    loadJSON(text) {
      alive();
      const result = current.loadGraphics(JSON.parse(text));
      state.selected = result[0]?.id || state.selected;
      refresh();
      log("静默追加完成", { count: result.length });
      return result;
    },
    exportJSON() {
      alive();
      const text = JSON.stringify(current.getGraphics(), null, 2);
      if (config.jsonEditor) config.jsonEditor.value = text;
      log("已导出 JSON", { count: current.getGraphics().length });
      return text;
    },
    loadSamples() {
      return demo.loadJSON(
        JSON.stringify(samples().map((item) => ({ ...item, style: style() }))),
      );
    },
    snapshot() {
      const record = demo.getGraphic();
      if (!record) throw new Error("请先选择图形");
      const before = JSON.stringify(record);
      record.positions[0][0] = 0;
      log("修改快照不影响图形", {
        passed: JSON.stringify(current.getGraphic(record.id)) === before,
        lastDrawResult: lastSnapshot,
      });
    },
    menu(vertex = false) {
      const shape = selectedShape();
      if (current.drawingShape) throw new Error("请先结束绘制");
      if (vertex) {
        if (!current.enableEdit) throw new Error("请先开启允许编辑");
        current.startEditing(shape);
      }
      current.showContextMenu(
        viewer.scene.canvas.clientWidth - 4,
        viewer.scene.canvas.clientHeight - 4,
        shape,
        vertex ? { vertexIndex: state.vertexIndex } : {},
      );
    },
    validate() {
      alive();
      if (current.drawingShape || current.editing)
        throw new Error("请先停止绘制与编辑，再运行校验用例");
      const before = JSON.stringify(current.getGraphics());
      const sameId = Cesium.createGuid();
      const invalid = [
        { type: "point", positions: [[110, 91]] },
        {
          type: "rect",
          positions: [
            [110, 30],
            [110, 30],
            [110, 31],
            [110, 31],
          ],
        },
        {
          type: "circle",
          positions: [
            [110, 30],
            [110, 30],
          ],
        },
        {
          type: "ellipse",
          positions: [
            [110, 30],
            [110.1, 30],
            [110, 31],
          ],
        },
        { type: "point", positions: [[110, 30]], style: { color: "invalid" } },
      ];
      const results = invalid.map((data) => {
        try {
          current.loadGraphics([samples()[0], data]);
          return { type: data.type, rejected: false };
        } catch (error) {
          return { type: data.type, rejected: true, message: error.message };
        }
      });
      try {
        current.loadGraphics([
          { ...samples()[0], id: sameId },
          { ...samples()[0], id: sameId },
        ]);
        results.push({ duplicateId: false });
      } catch (error) {
        results.push({ duplicateId: true, message: error.message });
      }
      const passed =
        results.every((item) => item.rejected ?? item.duplicateId) &&
        before === JSON.stringify(current.getGraphics());
      log("非法数据与批次原子性", { passed, results });
      if (!passed) throw new Error("校验用例未通过，请检查日志");
      return true;
    },
    destroy() {
      if (disposed) return;
      current.destroy();
      destroyed = true;
      unbind();
      log("已完整销毁", {
        externalLayerPreserved: externalLayer
          ? viewer.dataSources.contains(externalLayer)
          : null,
        remainingExternalEntities: externalLayer?.entities.values.length ?? 0,
      });
      refresh();
    },
    async recreate() {
      if (disposed) throw new Error("面板已释放");
      if (recreating) throw new Error("正在重建，请稍候");
      recreating = true;
      try {
        demo.destroy();
        // 业务主动移除旧外部图层；DrawTool.destroy 本身不会移除它。
        if (externalLayer) viewer.dataSources.remove(externalLayer, true);
        externalLayer =
          state.layerMode === "外部共享图层"
            ? new Cesium.CustomDataSource("演示业务图层")
            : null;
        if (externalLayer) {
          externalLayer.entities.add({
            id: "business-point",
            position: Cesium.Cartesian3.fromDegrees(107, 32),
            point: { pixelSize: 16, color: Cesium.Color.YELLOW },
          });
        }
        current = new DrawTool(viewer, {
          ...(externalLayer ? { dataSource: externalLayer } : {}),
          enableEdit: state.enableEdit,
          autoEdit: state.autoEdit,
          style: style(),
        });
        destroyed = false;
        state.selected = "";
        lastSnapshot = null;
        current.dataSource.show = state.layerVisible;
        bind();
        const owner = current;
        const layer = externalLayer;
        if (layer) {
          await viewer.dataSources.add(layer);
          if (disposed && !viewer.isDestroyed())
            viewer.dataSources.remove(layer, true);
        }
        await owner.ready;
        if (owner === current && !disposed && !destroyed) {
          log("ready 已完成", { layer: state.layerMode });
          refresh();
        }
      } finally {
        recreating = false;
      }
    },
    async ready() {
      alive();
      await current.ready;
      log("图层 ready 已完成");
    },
    refresh,
  };
  gui.demo = demo;
  const button = (folder, label, action) =>
    folder.add({ action: run(action) }, "action").name(label);
  const drawing = gui.addFolder("1 · 绘制与样式");
  drawing.add(state, "mode", ["Promise", "回调", "类型方法"]).name("调用方式");
  drawing.add(state, "id").name("自定义 ID（可空）");
  drawing.addColor(state, "color").name("颜色");
  drawing.add(state, "lineWidth", 1, 12, 1).name("线宽");
  drawing.add(state, "pointSize", 4, 30, 1).name("点大小");
  drawing.add(state, "clampToGround").name("贴地（点除外）");
  Object.entries(typeNames).forEach(([type, name]) =>
    button(drawing, `绘制${name}`, () => demo.start(type)),
  );
  button(drawing, "停止绘制（取消）", demo.stopDraw);
  button(drawing, "清除控制点重新绘制", demo.clearDrawing);
  const edit = gui.addFolder("2 · 查询、编辑与菜单");
  edit
    .add(state, "enableEdit")
    .name("允许编辑")
    .onChange(
      run(() => {
        alive();
        current.enableEdit = state.enableEdit;
      }),
    );
  edit
    .add(state, "autoEdit")
    .name("完成后自动编辑")
    .onChange(
      run(() => {
        alive();
        current.autoEdit = state.autoEdit;
      }),
    );
  selectedController = edit
    .add(state, "selected", { "（请选择）": "" })
    .name("目标图形");
  button(edit, "查询选中图形", () => demo.getGraphic());
  button(edit, "查询全部图形", demo.getGraphics);
  button(edit, "开始编辑", demo.startEditing);
  button(edit, "停止编辑", demo.stopEditing);
  button(edit, "按 ID 删除图形", () => demo.removeGraphic());
  button(edit, "按 shape 删除图形", () => {
    current.removeGraphic(selectedShape());
    refresh();
  });
  button(edit, "右下角菜单", () => demo.menu());
  edit.add(state, "vertexIndex", 0, 30, 1).name("顶点索引（从 0）");
  button(edit, "顶点删除菜单", () => demo.menu(true));
  button(edit, "关闭菜单", () => current.hideContextMenu());
  edit
    .add(state, "menuTheme")
    .name("自定义菜单样式")
    .onChange((value) =>
      document.body.classList.toggle("demo-menu-theme", value),
    );
  const data = gui.addFolder("3 · 回显与数据");
  data
    .add(
      state,
      "sampleType",
      Object.fromEntries(
        Object.entries(typeNames).map(([key, value]) => [value, key]),
      ),
    )
    .name("单个样例类型");
  button(data, "addGraphic 单个样例", () =>
    demo.addGraphic({
      ...samples().find((item) => item.type === state.sampleType),
      style: style(),
    }),
  );
  button(data, "加载六类样例（追加）", demo.loadSamples);
  button(data, "导出到 JSON 编辑框", demo.exportJSON);
  button(data, "从 JSON 追加回显", () =>
    demo.loadJSON(config.jsonEditor?.value || ""),
  );
  button(data, "清空全部图形（可复用）", demo.clear);
  button(data, "验证快照隔离", demo.snapshot);
  button(data, "验证非法数据与重复 ID", demo.validate);
  button(data, "跨日期变更线样例", () => {
    demo.addGraphic({
      type: "line",
      positions: [
        [179, 10],
        [-179, 12],
      ],
      style: style(),
    });
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(180, 11, 1000000),
    });
  });
  const lifecycle = gui.addFolder("4 · 图层、事件与生命周期");
  lifecycle
    .add(state, "layerVisible")
    .name("图层显隐")
    .onChange(
      run(() => {
        alive();
        current.dataSource.show = state.layerVisible;
        viewer.scene.requestRender();
      }),
    );
  lifecycle.add(state, "eventLogging").name("记录全部事件");
  button(lifecycle, "移除演示事件监听（off）", () => {
    unbind();
    log("已移除本面板监听器");
  });
  button(lifecycle, "恢复演示事件监听（on）", () => {
    alive();
    unbind();
    bind();
    log("已恢复全部十类事件监听");
  });
  button(lifecycle, "清空日志", () => {
    logs.length = 0;
    if (config.output) config.output.textContent = "";
  });
  lifecycle
    .add(state, "layerMode", ["自建图层", "外部共享图层"])
    .name("重建时使用");
  button(lifecycle, "等待图层 ready", demo.ready);
  button(lifecycle, "销毁实例", demo.destroy);
  button(lifecycle, "重建实例（清除旧数据）", demo.recreate);
  const scene = gui.addFolder("5 · 视图与按需渲染");
  scene
    .add(state, "requestRenderMode")
    .name("按需渲染")
    .onChange((value) => {
      viewer.scene.requestRenderMode = value;
      viewer.scene.maximumRenderTimeChange = value ? Infinity : 0;
      viewer.scene.requestRender();
    });
  scene
    .add(state, "fps")
    .name("显示帧率")
    .onChange((value) => {
      viewer.scene.debugShowFramesPerSecond = value;
      viewer.scene.requestRender();
    });
  button(scene, "定位选中图形", () => viewer.flyTo(selectedShape().mainEntity));
  button(scene, "返回样例区域", () =>
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(112, 31, 1500000),
    }),
  );
  button(scene, "主动请求一帧", () => viewer.scene.requestRender());
  [edit, data, lifecycle, scene].forEach((folder) => folder.close());
  bind();
  refresh();
  const originalDestroy = gui.destroy.bind(gui);
  gui.destroy = () => {
    if (disposed) return;
    demo.destroy();
    disposed = true;
    if (externalLayer) viewer.dataSources.remove(externalLayer, true);
    document.body.classList.remove("demo-menu-theme");
    originalDestroy();
  };
  return gui;
}
