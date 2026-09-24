import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import Draw from "../js/drawTool.js";

// 使用仓库实际 Cesium 数据模型，鼠标与 DOM 由最小桩替代。
vm.runInThisContext(
  readFileSync(new URL("../libs/Cesium/Cesium.js", import.meta.url), "utf8"),
);
const C = globalThis.Cesium;
assert.ok(C?.EntityCollection, "Cesium 应可加载");
class Handler {
  constructor() {
    this.actions = new Map();
  }
  setInputAction(callback, type) {
    this.actions.set(type, callback);
  }
  destroy() {
    this.actions.clear();
  }
}
// 使用代理保留原生 Entity、CallbackProperty、坐标和颜色运算。
globalThis.Cesium = new Proxy(C, {
  get(target, key) {
    return key === "ScreenSpaceEventHandler" ? Handler : target[key];
  },
});
globalThis.document = { body: { style: {} }, removeEventListener() {} };
const layer = new C.CustomDataSource("测试共享图层");
const foreign = layer.entities.add({ id: "foreign" });
let picked;
const viewer = {
  scene: { canvas: {}, pick: () => picked, screenSpaceCameraController: {} },
  cesiumWidget: { screenSpaceEventHandler: { removeInputAction() {} } },
};
const draw = new Draw(viewer, { dataSource: layer, autoEdit: true });
const events = [];
for (const name of [
  "drawStart",
  "drawAddPoint",
  "drawEnd",
  "editStart",
  "editStop",
  "editMovePoint",
  "editAddPoint",
  "editRemovePoint",
  "removeGraphic",
]) {
  draw.on(name, (data) => events.push({ name, id: data.id }));
}
const style = {
  lineWidth: 3,
  color: "#ff5500",
  pointSize: 12,
  clampToGround: true,
};
const inputs = [
  { id: "p", type: "point", positions: [[110, 30]] },
  {
    id: "l",
    type: "line",
    positions: [
      [110, 30],
      [111, 31],
      [112, 30],
    ],
  },
  {
    id: "r",
    type: "rect",
    positions: [
      [110, 30],
      [112, 30],
      [112, 32],
      [110, 32],
    ],
  },
  {
    id: "g",
    type: "polygon",
    positions: [
      [110, 30],
      [112, 30],
      [111, 32],
    ],
  },
  {
    id: "c",
    type: "circle",
    positions: [
      [110, 30],
      [111, 30],
    ],
  },
  {
    id: "e",
    type: "ellipse",
    positions: [
      [110, 30],
      [112, 30],
      [110, 30.5],
    ],
  },
].map((data) => ({
  ...data,
  style: { ...style, clampToGround: data.type !== "point" },
}));
const source = structuredClone(inputs);
assert.deepEqual(draw.loadGraphics(source), inputs);
assert.deepEqual(events, [], "回显不可触发交互事件");
assert.equal(draw.interactionHandler, null);
assert.equal(draw.editingShape, null);
assert.equal(draw.drawingShape, null);
assert.equal(draw.getGraphic("missing"), null);
source[0].positions[0][0] = 0;
source[0].style.color = "blue";
const exported = draw.getGraphics();
exported[0].positions[0][0] = 1;
exported[0].style.color = "green";
assert.deepEqual(draw.getGraphics(), inputs, "输入与输出须独立复制");
for (const shape of draw.shapes) {
  assert.equal(draw.findShapeByFeature({ id: shape.mainEntity }), shape);
  for (const vertex of shape.controlPointEntities) {
    if (vertex !== shape.mainEntity) assert.equal(vertex.show, false);
  }
}
const saved = JSON.stringify(draw.getGraphics());
draw.clear();
assert.deepEqual(
  events.map((e) => e.name),
  Array(6).fill("removeGraphic"),
);
assert.deepEqual(layer.entities.values, [foreign]);
events.length = 0;
assert.deepEqual(draw.loadGraphics(JSON.parse(saved)), inputs);
assert.deepEqual(events, []);
const now = C.JulianDate.now();
// 验证椭圆和圆的动态属性与控制点一致。
for (const id of ["c", "e"]) {
  const shape = draw.shapes.find((s) => s.id === id);
  const expected = C.Cartesian3.distance(
    C.Cartesian3.fromDegrees(...shape.controlPoints[0]),
    C.Cartesian3.fromDegrees(...shape.controlPoints[1]),
  );
  assert.equal(shape.mainEntity.ellipse.semiMajorAxis.getValue(now), expected);
  assert.equal(shape.mainEntity.ellipse.semiMajorAxis.isConstant, true);
  draw.startEditing(shape);
  shape.controlPoints[1][0] += 0.1;
  assert.notEqual(
    shape.mainEntity.ellipse.semiMajorAxis.getValue(now),
    expected,
  );
  draw.stopEditing();
}
const rect = draw.shapes.find((s) => s.id === "r");
draw.startEditing(rect);
draw._moveControlPoint(rect, 1, [113, 29]);
assert.deepEqual(draw.getGraphic("r").positions, [
  [110, 29],
  [113, 29],
  [113, 32],
  [110, 32],
]);
assert.equal(
  rect.mainEntity.polygon.hierarchy.getValue(now).positions.length,
  4,
);
draw.stopEditing();
// 真实编辑事件入口：中间点插入、拖拽、删除及退出。
const line = draw.shapes.find((s) => s.id === "l");
draw.pickLonLat = (position) => position;
draw.startEditing(line);
picked = { id: line.midpointEntities[0] };
draw.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_DOWN)({
  position: [110.5, 30.5],
});
assert.equal(line.controlPoints.length, 4);
assert.equal(events.at(-1).name, "editAddPoint");
draw.interactionHandler.actions.get(C.ScreenSpaceEventType.MOUSE_MOVE)({
  endPosition: [110.6, 30.6],
});
draw.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_UP)();
assert.equal(events.at(-1).name, "editMovePoint");
draw._removeVertex(line, 1);
assert.equal(events.at(-1).name, "editRemovePoint");
assert.equal(line.controlPoints.length, 3);
assert.throws(() => draw.loadGraphics([]), /结束/);
draw.stopEditing();
draw.drawingShape = {};
assert.throws(() => draw.loadGraphics([]), /结束/);
draw.drawingShape = null;
// 缺省 id 自动生成，返回和导出保留标识，不修改输入。
const autoTool = new Draw(viewer, {
  dataSource: new C.CustomDataSource("自动标识"),
});
const noId = { type: "point", positions: [[100, 20]] };
const autoOne = autoTool.addGraphic(noId);
const autoBatch = autoTool.loadGraphics([noId, { ...noId, id: undefined }]);
const autoRecords = [autoOne, ...autoBatch];
assert.equal(new Set(autoRecords.map((item) => item.id)).size, 3);
for (const record of autoRecords) {
  assert.equal(typeof record.id, "string");
  assert.ok(record.id.length > 0);
  assert.deepEqual(autoTool.getGraphic(record.id), record);
}
assert.equal(Object.hasOwn(noId, "id"), false);
for (const id of [null, "", "   ", 123]) {
  assert.throws(() => autoTool.addGraphic({ ...noId, id }), /id/);
}
const autoSaved = JSON.parse(JSON.stringify(autoTool.getGraphics()));
autoTool.clear();
assert.deepEqual(autoTool.loadGraphics(autoSaved), autoSaved);
autoTool.clear();
// 完整预校验：不生成任何实体或事件。
const before = [...layer.entities.values];
const beforeData = draw.getGraphics();
events.length = 0;
const fresh = { id: "fresh", type: "point", positions: [[100, 20]] };
for (const bad of [
  { ...fresh, id: "foreign" },
  { ...fresh, id: "p" },
  { ...fresh, id: "" },
  { ...fresh, type: "bad" },
  { ...fresh, positions: [[NaN, 20]] },
  { ...fresh, positions: [[100, 91]] },
  { ...fresh, positions: [[100, 20, 0]] },
  { ...fresh, style: { color: "invalid" } },
  { ...fresh, style: { pointSize: -1 } },
  {
    ...fresh,
    type: "rect",
    positions: [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  },
]) {
  assert.throws(() => draw.addGraphic(bad));
}
assert.throws(() => draw.loadGraphics([fresh, fresh]));
assert.deepEqual(draw.loadGraphics([]), []);
assert.deepEqual(layer.entities.values, before);
assert.deepEqual(draw.getGraphics(), beforeData);
assert.deepEqual(events, []);
// 第二个图形创建中失败：已登记图形及未登记辅助实体全部回滚。
const original = draw.createPointEntity;
let calls = 0;
draw.createPointEntity = function (...args) {
  if (++calls === 2) throw new Error("模拟创建失败");
  return original.apply(this, args);
};
assert.throws(
  () =>
    draw.loadGraphics([
      fresh,
      {
        id: "rollback",
        type: "point",
        positions: [[10, 10]],
      },
    ]),
  /模拟创建失败/,
);
draw.createPointEntity = original;
assert.deepEqual(layer.entities.values, before);
assert.deepEqual(draw.getGraphics(), beforeData);
assert.deepEqual(events, []);
assert.equal(draw._loadingGraphics, false);
// 禁用编辑不影响回显与单实体删除。
draw.enableEdit = false;
const item = draw.addGraphic(fresh);
draw.startEditing(draw.shapes.find((s) => s.id === item.id));
assert.equal(draw.editingShape, null);
draw.removeGraphic(draw.shapes.find((s) => s.id === item.id));
assert.equal(events.at(-1).name, "removeGraphic");
// 支持按 ID 删除，重复删除及外部实体 ID 不触发事件。
const byId = draw.addGraphic(fresh);
const eventCount = events.length;
draw.removeGraphic(byId.id);
assert.equal(layer.entities.getById(byId.id), undefined);
assert.equal(
  draw.shapes.some((s) => s.mainEntity.id === byId.id),
  false,
);
assert.equal(events.length, eventCount + 1);
assert.equal(events.at(-1).name, "removeGraphic");
draw.removeGraphic(byId.id);
draw.removeGraphic("foreign");
draw.removeGraphic(null);
draw.removeGraphic();
assert.equal(events.length, eventCount + 1);
assert.equal(layer.entities.getById("foreign"), foreign);
// 六种交互入口完成后，导出、序列化、清空、回显应保持一致。
for (const input of inputs) {
  const tool = new Draw(viewer, {
    dataSource: new C.CustomDataSource("交互回归"),
    autoEdit: true,
  });
  tool.pickLonLat = (position) => position;
  const order = [];
  for (const name of ["drawStart", "drawAddPoint", "drawEnd", "editStart"]) {
    tool.on(name, () => order.push(name));
  }
  tool.startDraw({
    type: input.type,
    id: input.id,
    style: input.style,
    success: () => order.push("success"),
  });
  const points =
    input.type === "rect"
      ? [input.positions[0], input.positions[2]]
      : input.positions;
  for (const point of points) {
    tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_CLICK)({
      position: [...point],
    });
  }
  if (input.type === "line" || input.type === "polygon") {
    tool.drawingShape.firstPointTime = null;
    tool.interactionHandler.actions.get(
      C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    )();
  }
  assert.deepEqual(order, [
    "drawStart",
    ...points.map(() => "drawAddPoint"),
    "drawEnd",
    "success",
    "editStart",
  ]);
  tool.stopEditing();
  const snapshot = tool.getGraphics();
  tool.clear();
  order.length = 0;
  assert.deepEqual(
    tool.loadGraphics(JSON.parse(JSON.stringify(snapshot))),
    snapshot,
  );
  assert.deepEqual(order, []);
  tool.clear();
}
// 生命周期、状态重入及取消的回归。
function makeTool() {
  const testViewer = {
    ...viewer,
    scene: {
      ...viewer.scene,
      screenSpaceCameraController: {
        enableRotate: true,
        enableTranslate: false,
        enableZoom: false,
        enableTilt: true,
        enableLook: false,
      },
      requestRender() {},
    },
  };
  const tool = new Draw(testViewer, {
    dataSource: new C.CustomDataSource("回归"),
    autoEdit: false,
  });
  tool.pickLonLat = (position) => position;
  return tool;
}
const click = (tool, position) =>
  tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_CLICK)({
    position,
  });
const move = (tool, position) =>
  tool.interactionHandler.actions.get(C.ScreenSpaceEventType.MOUSE_MOVE)({
    endPosition: position,
  });
for (const input of inputs) {
  const tool = makeTool();
  const pending = tool.startDraw({ type: input.type });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  if (input.type !== "point") click(tool, [10, 10]);
  tool.startDraw({ type: "point", success() {} });
  await rejected;
  tool.stopDraw();
  assert.equal(
    tool.dataSource.entities.values.length,
    0,
    `${input.type} 切换不能残留实体`,
  );
  tool.destroy();
}
for (const action of ["stopDraw", "clear", "destroy"]) {
  const tool = makeTool();
  const rejected = assert.rejects(tool.startDraw({ type: "line" }), {
    name: "AbortError",
  });
  tool[action]();
  await rejected;
  tool.destroy();
}
for (const type of ["line", "polygon"]) {
  const tool = makeTool();
  tool.startDraw({ type, success() {} });
  click(tool, [10, 10]);
  click(tool, [11, 11]);
  const shape = tool.drawingShape;
  tool.clearDrawing();
  click(tool, [20, 20]);
  click(tool, [21, 21]);
  click(tool, [22, 20]);
  const property =
    type === "line"
      ? shape.mainEntity.polyline.positions
      : shape.mainEntity.polygon.hierarchy;
  const value = property.getValue(now);
  assert.deepEqual(
    type === "line" ? value : value.positions,
    tool.positionsToCartesian(shape.controlPoints),
  );
  tool.destroy();
  const insufficient = makeTool();
  const rejected = assert.rejects(insufficient.startDraw({ type }), {
    name: "AbortError",
  });
  click(insufficient, [10, 10]);
  insufficient.drawingShape.firstPointTime = null;
  insufficient.interactionHandler.actions.get(
    C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
  )();
  await rejected;
  insufficient.destroy();
}
{
  const tool = makeTool();
  const record = tool.addGraphic(inputs[1]);
  const shape = tool.shapes[0];
  tool.on("editStart", () => tool.stopEditing());
  tool.startEditing(shape);
  assert.equal(tool.editingShape, null);
  assert.equal(tool.interactionHandler, null);
  tool.off("editStart");
  let stops = 0;
  tool.on("editStop", () => {
    stops++;
    tool.clear();
  });
  tool.startEditing(shape);
  tool.stopEditing();
  assert.equal(stops, 1);
  assert.equal(tool.getGraphic(record.id), null);
  tool.destroy();
}
{
  const tool = makeTool();
  tool.addGraphic(inputs[1]);
  tool.on("editStop", () => tool.startDraw({ type: "point", success() {} }));
  tool.startEditing(tool.shapes[0]);
  const canceled = assert.rejects(tool.startDraw({ type: "circle" }), {
    name: "AbortError",
  });
  await canceled;
  assert.equal(tool.drawingShape.type, "point", "监听器新会话不应被外层覆盖");
  tool.destroy();
}
{
  const tool = makeTool();
  tool.addGraphic(inputs[1]);
  const shape = tool.shapes[0];
  const controller = tool.viewer.scene.screenSpaceCameraController;
  const previous = { ...controller };
  document.body.style.cursor = "help";
  tool.startEditing(shape);
  picked = { id: shape.controlPointEntities[0] };
  tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_DOWN)({
    position: [110, 30],
  });
  assert.equal(controller.enableRotate, false);
  tool.enableEdit = false;
  assert.deepEqual(controller, previous);
  assert.equal(document.body.style.cursor, "help");
  assert.equal(tool.editingShape, null);
  assert.equal(
    tool.dataSource.entities.values.length,
    1,
    "退出编辑只保留主实体",
  );
  assert.equal(shape.mainEntity.polyline.positions.isConstant, true);
  tool.destroy();
}
{
  const tool = makeTool();
  tool.startDraw({ type: "rect", success() {} });
  click(tool, [10, 10]);
  click(tool, [10, 11]);
  assert.equal(tool.drawingShape.controlPoints.length, 1);
  click(tool, [11, 11]);
  const shape = tool.shapes[0];
  tool.startEditing(shape);
  const saved = tool.getGraphic(shape.id);
  tool._moveControlPoint(shape, 0, [11, 10]);
  assert.deepEqual(tool.getGraphic(shape.id), saved);
  tool.stopEditing();
  tool.startDraw({ type: "ellipse", success() {} });
  click(tool, [10, 10]);
  click(tool, [11, 10]);
  click(tool, [10, 12]);
  click(tool, [10, 10]);
  assert.equal(tool.drawingShape.controlPoints.length, 2);
  click(tool, [10, 10.5]);
  const records = tool.getGraphics();
  tool.clear();
  assert.deepEqual(tool.loadGraphics(records), records);
  tool.destroy();
}
{
  const tool = makeTool();
  let captured;
  tool.on("drawEnd", (data) => {
    captured = data;
    data.positions[0][0] = 99;
  });
  let second;
  tool.on("drawEnd", (data) => {
    second = data;
  });
  const pending = tool.startDraw({ type: "point" });
  click(tool, [10, 10]);
  const result = await pending;
  assert.deepEqual(result.positions, [[10, 10]]);
  assert.deepEqual(second.positions, [[10, 10]]);
  assert.deepEqual(tool.getGraphic(result.id).positions, [[10, 10]]);
  tool.startEditing(tool.shapes[0]);
  tool._moveControlPoint(tool.shapes[0], 0, [11, 11]);
  assert.deepEqual(result.positions, [[10, 10]]);
  assert.equal(captured.positions[0][0], 99);
  const originalError = console.error;
  let errors = 0;
  console.error = () => errors++;
  try {
    tool.on("toString", () => {
      throw new Error("监听器错误");
    });
    let notified = false;
    tool.on("toString", () => {
      notified = true;
    });
    tool.emit("toString", {});
    assert.equal(errors, 1);
    assert.ok(notified);
  } finally {
    console.error = originalError;
  }
  tool.destroy();
}
{
  const tool = makeTool();
  const record = tool.addGraphic({
    type: "line",
    positions: [
      [179, 10],
      [-179, 12],
    ],
  });
  const shape = tool.shapes[0];
  assert.deepEqual(tool._getMidpoint(...shape.controlPoints), [-180, 11]);
  assert.deepEqual(tool._getTranslationCenter(shape), [-180, 11]);
  tool.startEditing(shape);
  const previous = tool.getGraphic(record.id);
  tool._moveControlPoint(shape, 0, [179, 91]);
  assert.deepEqual(tool.getGraphic(record.id), previous);
  picked = { id: shape.translationHandleEntity };
  tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_DOWN)({
    position: [179, 11],
  });
  move(tool, [-179, 11]);
  assert.deepEqual(tool.getGraphic(record.id).positions, [
    [-179, 10],
    [-177, 12],
  ]);
  tool.destroy();
}
{
  const tool = makeTool();
  const originalFactory = tool.createPolylineEntity;
  tool.createPolylineEntity = () => {
    throw new Error("初始化失败");
  };
  await assert.rejects(tool.startDraw({ type: "line" }), /初始化失败/);
  assert.equal(tool.drawingShape, null);
  assert.equal(tool.dataSource.entities.values.length, 0);
  tool.createPolylineEntity = originalFactory;
  await assert.rejects(tool.startDraw({ type: "unsupported" }), /不支持/);
  await assert.rejects(
    tool.startDraw({ type: "point", style: { color: "invalid" } }),
    /样式/,
  );
  tool.destroy();
  tool.destroy();
  await assert.rejects(tool.startDraw({ type: "point" }), /销毁/);
  assert.throws(() => tool.loadGraphics([]), /销毁/);
}
{
  let resolveAdd;
  const removed = [];
  const action = () => {};
  const inputActions = new Map([
    [C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK, action],
  ]);
  const ownViewer = {
    ...viewer,
    dataSources: {
      add: () =>
        new Promise((resolve) => {
          resolveAdd = resolve;
        }),
      remove: (layer) => removed.push(layer),
    },
    cesiumWidget: {
      screenSpaceEventHandler: {
        getInputAction: (type) => inputActions.get(type),
        removeInputAction: (type) => inputActions.delete(type),
        setInputAction: (callback, type) => inputActions.set(type, callback),
      },
    },
  };
  const one = new Draw(ownViewer);
  const two = new Draw(ownViewer, {
    dataSource: new C.CustomDataSource("外部"),
  });
  one.destroy();
  assert.equal(inputActions.size, 0);
  resolveAdd(one.dataSource);
  await one.ready;
  assert.equal(removed.at(-1), one.dataSource);
  two.destroy();
  assert.equal(
    inputActions.get(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK),
    action,
  );
  assert.ok(!removed.includes(two.dataSource));
}
// 两点线段的插点手柄与平移中心分离，增删点和重新编辑后保持一致。
for (const clampToGround of [false, true]) {
  const tool = makeTool();
  tool.startDraw({ type: "line", style: { clampToGround }, success() {} });
  click(tool, [10, 10]);
  click(tool, [14, 10]);
  tool.drawingShape.firstPointTime = null;
  tool.interactionHandler.actions.get(
    C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
  )();
  const shape = tool.shapes[0];
  tool.startEditing(shape);
  const checkHandle = (position) => {
    assert.deepEqual(
      shape.midpointEntities[0].position.getValue(now),
      C.Cartesian3.fromDegrees(...position),
    );
    assert.notDeepEqual(
      shape.midpointEntities[0].position.getValue(now),
      shape.translationHandleEntity.position.getValue(now),
    );
  };
  checkHandle([11, 10]);
  picked = { id: shape.translationHandleEntity };
  tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_DOWN)({
    position: [12, 10],
  });
  move(tool, [13, 11]);
  tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_UP)();
  assert.deepEqual(shape.controlPoints, [
    [11, 11],
    [15, 11],
  ]);
  checkHandle([12, 11]);
  tool._moveControlPoint(shape, 1, [19, 11]);
  checkHandle([13, 11]);
  picked = { id: shape.midpointEntities[0] };
  tool.pickLonLat = () => null;
  tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_DOWN)({
    position: [13, 11],
  });
  assert.deepEqual(
    shape.controlPoints,
    [
      [11, 11],
      [13, 11],
      [19, 11],
    ],
    "拾取地面失败时仍在辅助点位置插点",
  );
  tool.pickLonLat = (position) => position;
  move(tool, [13, 12]);
  tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_UP)();
  assert.deepEqual(
    shape.midpointEntities[0].position.getValue(now),
    C.Cartesian3.fromDegrees(12, 11.5),
  );
  tool._removeVertex(shape, 1);
  checkHandle([13, 11]);
  tool.stopEditing();
  tool.startEditing(shape);
  checkHandle([13, 11]);
  tool._moveControlPoint(shape, 0, [179, 10]);
  tool._moveControlPoint(shape, 1, [-177, 10]);
  checkHandle([-180, 10]);
  tool.destroy();
}
// 中心重叠时，无论拾取哪个实体，都应同步平移所有控制点。
for (const type of ["circle", "ellipse"]) {
  for (const target of ["controlPoint", "translationHandle"]) {
    const tool = makeTool();
    const input = inputs.find((item) => item.type === type);
    tool.addGraphic(input);
    const shape = tool.shapes[0];
    tool.startEditing(shape);
    picked = {
      id:
        target === "controlPoint"
          ? shape.controlPointEntities[0]
          : shape.translationHandleEntity,
    };
    tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_DOWN)({
      position: [110, 30],
    });
    move(tool, [111, 31]);
    tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_UP)();
    const expected = input.positions.map(([lon, lat]) => [lon + 1, lat + 1]);
    assert.deepEqual(tool.getGraphic(input.id).positions, expected);
    tool.stopEditing();
    assert.equal(shape.mainEntity.ellipse.semiMajorAxis.isConstant, true);
    const saved = tool.getGraphics();
    tool.clear();
    assert.deepEqual(tool.loadGraphics(saved), saved);
    tool.destroy();
  }
}
{
  const tool = makeTool();
  const points = [
    [10, 10],
    [11, 11],
  ];
  assert.equal(tool.createPolylineEntity(points).polyline.zIndex, undefined);
  assert.equal(
    tool
      .createPolylineEntity(points, { clampToGround: true })
      .polyline.zIndex.getValue(now),
    1,
  );
  tool.destroy();
}
// 绘制及各类拖拽使用 crosshair，结束后恢复业务原光标。
for (const input of inputs) {
  const tool = makeTool();
  document.body.style.cursor = "help";
  tool.startDraw({ type: input.type, success() {} });
  assert.equal(document.body.style.cursor, "crosshair");
  tool.clearDrawing();
  assert.equal(document.body.style.cursor, "crosshair");
  tool.stopDraw();
  assert.equal(document.body.style.cursor, "help");
  tool.addGraphic(input);
  const shape = tool.shapes[0];
  tool.startEditing(shape);
  for (const entity of [
    shape.controlPointEntities[0],
    shape.translationHandleEntity,
    shape.midpointEntities?.[0],
  ].filter(Boolean)) {
    picked = { id: entity };
    const position =
      entity === shape.midpointEntities?.[0]
        ? tool._getInsertionHandlePosition(shape, 0)
        : input.positions[0];
    tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_DOWN)({
      position,
    });
    assert.equal(document.body.style.cursor, "crosshair");
    tool.interactionHandler.actions.get(C.ScreenSpaceEventType.LEFT_UP)();
    assert.equal(document.body.style.cursor, "help");
  }
  tool.destroy();
  assert.equal(document.body.style.cursor, "help");
}
// 演示控制层：仅替换 lil-gui DOM 层，仍使用真实 DrawTool 与 Cesium 数据模型。
class DemoGUI {
  constructor() {
    this.domElement = { style: {} };
    this.controls = [];
    this.folders = [];
  }
  add(object, key) {
    const control = {
      object,
      key,
      label: key,
      name(value) {
        this.label = value;
        return this;
      },
      onChange(callback) {
        this.change = callback;
        return this;
      },
      options() {
        return this;
      },
      updateDisplay() {
        return this;
      },
    };
    this.controls.push(control);
    return control;
  }
  addColor(...args) {
    return this.add(...args);
  }
  addFolder() {
    const folder = new DemoGUI();
    this.folders.push(folder);
    return folder;
  }
  close() {}
  destroy() {}
}
globalThis.DemoGUI = DemoGUI;
const guiSource = readFileSync(new URL("../js/gui.js", import.meta.url), "utf8")
  .replace(
    'import GUI from "../libs/lil-gui.js";',
    "const GUI = globalThis.DemoGUI;",
  )
  .replace(
    '"./drawTool.js"',
    JSON.stringify(new URL("../js/drawTool.js", import.meta.url).href),
  );
const { default: initGui } = await import(
  `data:text/javascript;base64,${Buffer.from(guiSource).toString("base64")}`
);
delete globalThis.DemoGUI;
{
  document.body.classList = { toggle() {}, remove() {} };
  const tool = makeTool();
  const attached = new Set();
  tool.viewer.dataSources = {
    add: async (layer) => {
      attached.add(layer);
      return layer;
    },
    remove: (layer) => attached.delete(layer),
    contains: (layer) => attached.has(layer),
  };
  tool.viewer.isDestroyed = () => false;
  const output = { textContent: "" };
  const jsonEditor = { value: "" };
  const status = { textContent: "" };
  let completions = 0;
  const gui = initGui(tool, tool.viewer, {
    output,
    jsonEditor,
    status,
    onCoordinates: () => completions++,
  });
  const demo = gui.demo;
  assert.equal(gui.folders.length, 5);
  demo.loadSamples();
  assert.equal(demo.getGraphics().length, 6);
  demo.startEditing();
  demo.stopEditing();
  const json = demo.exportJSON();
  assert.equal(jsonEditor.value, json);
  demo.clear();
  assert.equal(demo.loadJSON(json).length, 6);
  assert.throws(() => demo.loadJSON(json), /已存在/);
  const previous = demo.exportJSON();
  assert.equal(demo.validate(), true);
  assert.equal(demo.exportJSON(), previous);
  demo.snapshot();
  assert.equal(demo.exportJSON(), previous);
  assert.throws(() => demo.loadJSON("{"), SyntaxError);
  const invoke = async (label) => {
    const control = gui.folders
      .flatMap((folder) => folder.controls)
      .find((item) => item.label === label);
    assert.ok(control, label);
    await control.object[control.key]();
  };
  jsonEditor.value = "{";
  await invoke("从 JSON 追加回显");
  assert.match(output.textContent, /操作失败/);
  await invoke("移除演示事件监听（off）");
  await invoke("恢复演示事件监听（on）");
  await invoke("恢复演示事件监听（on）");
  assert.equal(tool._events.get("drawEnd").length, 1);
  const canceled = demo.start("line", "Promise");
  demo.stopDraw();
  assert.equal(await canceled, null);
  for (const mode of ["Promise", "回调", "类型方法"]) {
    const result = demo.start("point", mode);
    click(tool, [110, 30]);
    await result;
  }
  assert.equal(completions, 3);
  demo.destroy();
  demo.destroy();
  await assert.rejects(demo.start("point"), /销毁/);
  demo.state.layerMode = "外部共享图层";
  await demo.recreate();
  const external = demo.draw.dataSource;
  demo.loadSamples();
  demo.clear();
  assert.ok(external.entities.getById("business-point"));
  demo.destroy();
  assert.ok(attached.has(external));
  assert.equal(external.entities.values.length, 1);
  demo.state.layerMode = "自建图层";
  await demo.recreate();
  assert.ok(!attached.has(external));
  assert.ok(attached.has(demo.draw.dataSource));
  demo.loadSamples();
  gui.destroy();
  gui.destroy();
  assert.equal(attached.size, 0);
  await assert.rejects(demo.recreate(), /释放/);
}
console.log(
  "PASS: graphics, lifecycle, cancellation, reentrancy, snapshots, camera, validation, static properties, center translation, demo GUI workflows",
);
