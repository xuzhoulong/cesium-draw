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
assert.equal(draw.handler, null);
assert.equal(draw.editShape, null);
assert.equal(draw.activeShape, null);
assert.equal(draw.getGraphic("missing"), null);
source[0].positions[0][0] = 0;
source[0].style.color = "blue";
const exported = draw.getGraphics();
exported[0].positions[0][0] = 1;
exported[0].style.color = "green";
assert.deepEqual(draw.getGraphics(), inputs, "输入与输出须独立复制");
for (const shape of draw.shapes) {
  assert.equal(draw.findShapeByFeature({ id: shape.mainEntity }), shape);
  for (const vertex of shape.pointsEntity) {
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
    C.Cartesian3.fromDegrees(...shape.points[0]),
    C.Cartesian3.fromDegrees(...shape.points[1]),
  );
  assert.equal(shape.mainEntity.ellipse.semiMajorAxis.getValue(now), expected);
  shape.points[1][0] += 0.1;
  assert.notEqual(
    shape.mainEntity.ellipse.semiMajorAxis.getValue(now),
    expected,
  );
}
const rect = draw.shapes.find((s) => s.id === "r");
rect.updatePoint(1, [113, 29]);
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
// 真实编辑事件入口：中间点插入、拖拽、删除及退出。
const line = draw.shapes.find((s) => s.id === "l");
draw.pickLonLat = (position) => position;
draw.startEditing(line);
picked = { id: line.midpointsEntity[0] };
draw.handler.actions.get(C.ScreenSpaceEventType.LEFT_DOWN)({
  position: [110.5, 30.5],
});
assert.equal(line.points.length, 4);
assert.equal(events.at(-1).name, "editAddPoint");
draw.handler.actions.get(C.ScreenSpaceEventType.MOUSE_MOVE)({
  endPosition: [110.6, 30.6],
});
draw.handler.actions.get(C.ScreenSpaceEventType.LEFT_UP)();
assert.equal(events.at(-1).name, "editMovePoint");
draw._removeVertex(line, 1);
assert.equal(events.at(-1).name, "editRemovePoint");
assert.equal(line.points.length, 3);
assert.throws(() => draw.loadGraphics([]), /结束/);
draw.stopEditing();
draw.activeShape = {};
assert.throws(() => draw.loadGraphics([]), /结束/);
draw.activeShape = null;
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
  if (++calls === 3) throw new Error("模拟创建失败");
  return original.apply(this, args);
};
assert.throws(
  () =>
    draw.loadGraphics([
      fresh,
      {
        id: "rollback",
        type: "line",
        positions: [
          [10, 10],
          [11, 11],
        ],
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
assert.equal(draw.editShape, null);
draw.removeGraphic(draw.shapes.find((s) => s.id === item.id));
assert.equal(events.at(-1).name, "removeGraphic");
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
    tool.handler.actions.get(C.ScreenSpaceEventType.LEFT_CLICK)({
      position: [...point],
    });
  }
  if (input.type === "line" || input.type === "polygon") {
    tool.activeShape.firstPointTime = null;
    tool.handler.actions.get(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)();
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
console.log(
  "PASS: graphics round-trip, interaction, events, validation, rollback, ownership",
);
