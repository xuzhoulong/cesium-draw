# Cesium DrawTool — Cesium 地图绘制工具

**在线访问地址：[xuzhoulong.github.io/cesium-draw/](https://xuzhoulong.github.io/cesium-draw/)**

> 基于 Cesium 的轻量级图形绘制与编辑工具库，支持画线、画点、画矩形、画多边形、画圆、画椭圆，绘制完成后可自由编辑（顶点拖拽 / 整体移动），并提供右键菜单、事件监听、停止/重新绘制等能力。**离线可用、零构建依赖、模块化易扩展。**

[中文](README.md) | [使用文档](docs/使用文档.md) | [开发文档](docs/开发文档.md)

---

## 图层接入

默认使用独立 `CustomDataSource`，可通过 `await draw.ready` 等待挂载，通过 `draw.dataSource` 控制显隐及查询实体（不再使用 `viewer.entities`）。也可传入业务图层：

```js
const layer = new Cesium.CustomDataSource("业务绘制图层");
await viewer.dataSources.add(layer);
const draw = new Draw(viewer, { dataSource: layer });
// layer.show = false;
// layer.entities.getById(id);
```

外部图层由业务侧负责挂载和移除。`draw.clear()` 仅删除当前工具拥有的实体，保留共享图层中的其他对象；同 ID 的外部对象禁止覆盖。移除图层前先 `draw.clear()`，以同步交互状态和删除事件。

## 数据保存与静默回显

```js
const json = JSON.stringify(draw.getGraphics()); // 全部已完成图形快照
const item = draw.getGraphic("myLine"); // 单个快照，未找到返回 null
// 业务从存储读取后，在空闲状态追加；不会自动清空或触发保存回调
const restored = draw.loadGraphics(JSON.parse(json));
// draw.addGraphic(item); // 单个回显，返回快照
```

记录格式为 `{ id, type, positions, style }`，输入、输出均独立复制。回显不传 `id`（或为 `undefined`）时自动生成，返回结果包含生成的 ID；请保存该 ID，避免重复加载时追加新图形。显式传入非法 ID 仍会报错。可在 `drawEnd` / `editStop` 中调用 `getGraphic(data.id)` 保存；原事件载荷保持不变。回显不触发绘制事件、`success` 或 `editStart`，不受 `autoEdit` 影响，之后可照常拾取、编辑、删除。

已有 ID（包括共享图层实体）冲突会拒绝加载；批量预校验，创建失败回滚本批实体。绘制或编辑期间需先 `stopDraw()` / `stopEditing()`。上述示例对原实例再次加载相同 ID 会报错；全量替换需业务显式 `clear()`，它仍会逐个触发 `removeGraphic`。不内置数据库、HTTP 或 localStorage。

六种坐标语义及校验见 [使用文档](docs/使用文档.md#数据保存与回显)。页面控制台可调用 `drawDemo.exportJSON()`、`drawDemo.loadJSON(text)`。

## ✨ 功能特性

- 🗺️ **六种绘制类型**：线、点、矩形、多边形、圆、椭圆，面板一键切换
- ✏️ **编辑能力**：
  - 拖拽顶点修改形状（矩形对角联动，始终保持矩形）
  - 拖动橙色中心手柄**整体移动**
  - 点击空白退出编辑、点击其他实体切换编辑
- 🖱️ **右键菜单**：开始编辑 / 停止编辑 / 删除实体
- 📡 **事件监听**：`editMovePoint`（编辑完点）、`editStop`（结束编辑），实时返回最新数据
- 🔁 **双模式调用**：回调（`success`）与异步（`Promise`）两种方式获取绘制结果
- 🏷️ **自定义实体 id**：绘制时传入 `id` 指定实体标识（冲突自动覆盖）
- 🛑 **绘制控制**：停止绘制（删除未完成实体）/ 重新绘制（清空重画）/ 清空图层
- 🎨 **样式可配**：默认样式 + 每次绘制的临时样式（线宽 / 颜色 / 点大小）
- 🚀 **离线可用**：内置离线 Cesium 与 lil-gui，无 CDN 依赖
- 🧩 **模块化设计**：每种绘制类型独立模块，共用会话、校验和资源管理

---

## 🖼️ 效果示意

![image-20260825162551077](image-20260825162551077.png)

```
线   ：左键加点 → 右键撤销 → 双击结束
矩形 ：两点对角，实时预览
多边形：单击加点 → 预览面实时闭合 → 双击定稿
编辑 ：拖控制点改形状 / 拖橙色中心手柄整体移动
```

---

## 🛠️ 技术栈

| 依赖                                         | 说明                               |
| -------------------------------------------- | ---------------------------------- |
| [Cesium](https://cesium.com/)                | 三维地球渲染（离线版 v1.140）      |
| [lil-gui](https://lil-gui.georgealways.com/) | 轻量控制面板（离线版 v0.19.1）     |
| 原生 JavaScript                              | ES Module，无构建工具、无 npm 依赖 |

---

## 🚀 快速开始

### 环境要求

浏览器通过**本地静态服务器**访问（ES Module 不支持 `file://` 直接打开）。

### 1. 启动项目

```bash
# 项目根目录启动静态服务
http-server
# 浏览器访问 http://localhost:8080
```

打开即可使用右侧面板绘制。

### 2. 集成到你的项目

```js
import Draw from "./js/drawTool.js";
import initGui from "./js/gui.js";

const viewer = new Cesium.Viewer("map", {
  baseLayer: false, // 关闭默认底图（避免 token 报错）
  baseLayerPicker: false,
  infoBox: false,
  selectionIndicator: false,
});
// 添加 XYZ 底图（示例：高德路网）
viewer.imageryLayers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url: "https://webrd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}",
  }),
);

// 创建绘制工具实例
const draw = new Draw(viewer, {
  enableEdit: true, // 是否支持编辑（默认 true）；false 时禁用所有编辑入口，autoEdit 随之失效
  autoEdit: true, // 绘制完自动进入编辑（默认 true）
  style: { lineWidth: 2, color: "#0092ff", pointSize: 10 }, // 默认样式
});

// 创建 lil-gui 面板（右上角按钮组）
initGui(draw, viewer);
```

---

## 📖 使用说明

### 面板按钮

**点 / 线 / 矩形 / 多边形 / 圆 / 椭圆 / 停止绘制 / 重新绘制 / 清空图层**

### 绘制交互

| 类型   | 交互                               | 完成       |
| ------ | ---------------------------------- | ---------- |
| 线     | 单击加点，右键删点（虚线实时重绘） | 双击结束   |
| 点     | 鼠标移动预览                       | 单击放置   |
| 矩形   | 两点对角，预览实时跟随             | 第二点点击 |
| 多边形 | 单击加点，预览面实时闭合，右键删点 | 双击闭合   |
| 圆     | 第一点圆心、第二点半径点           | 第二点点击 |
| 椭圆   | 圆心 → 长半轴点 → 短半轴点         | 第三点点击 |

### 编辑操作

| 操作             | 行为                             |
| ---------------- | -------------------------------- |
| 按住顶点拖动     | 修改顶点（矩形对角联动保持矩形） |
| 拖动橙色中心手柄 | **整体移动**                     |
| 点击空白         | 退出编辑                         |
| 点击其他实体     | 切换编辑                         |
| 右键实体         | 菜单：开始编辑 / 停止编辑 / 删除 |

---

## 📡 获取绘制结果

### 回调 / Promise

```js
// 回调方式
draw.startDraw({
  type: "line",
  id: "myLine",
  style: { color: "#ff0000" },
  success: (result) => console.log(result.id, result.positions, result.type),
});

// 异步方式
try {
  const result = await draw.startDraw({ type: "rect" });
  console.log(result); // { id, positions, type } 坐标快照
} catch (error) {
  if (error.name !== "AbortError") throw error;
}
```

### 事件监听

```js
// 编辑完一个点（拖拽松手）
draw.on("editMovePoint", (data) => console.log("编辑完点", data));

// 结束编辑
draw.on("editStop", (data) => console.log("结束编辑", data));

// 移除监听
draw.off("editMovePoint", handler);
```

> `positions` 均为独立快照，编辑后通过 `draw.getGraphic(id)` 获取最新数据（矩形返回推导的 4 角点）。

---

## ⚙️ 配置项

### Draw 实例

```js
new Draw(viewer, {
  enableEdit: true, // 是否支持编辑（默认 true）；false 时点击 / 右键菜单 / 自动编辑全部禁用，仅保留删除
  autoEdit: false, // 绘制完是否自动进入编辑（默认 true）
  style: {
    lineWidth: 2, // 线宽
    color: "#0092ff", // 颜色（线/面/点）
    pointSize: 10, // 点大小
  },
});
```

### startDraw

```js
draw.startDraw({
  id: "customId",               // 自定义实体 id（不传自动生成；传了覆盖同 id 旧实体）
  type: "circle",               // line / point / rect / polygon / circle / ellipse
  style: { color: "#00ff00" },  // 本次样式，覆盖默认
  success: (result) => { ... }, // 可选（与 Promise 二选一）
});
```

---

## 📁 目录结构

```
cesium_draw/
├── index.html                 # 页面入口
├── js/
│   ├── drawTool.js            # 核心类（公共方法 / 事件 / 分发 / 编辑 / 菜单）
│   ├── drawActions.js         # 动作层转发
│   ├── gui.js                 # lil-gui 面板
│   └── modules/               # 各绘制类型独立模块
│       ├── drawLine.js
│       ├── drawPoint.js
│       ├── drawRect.js
│       ├── drawPolygon.js
│       ├── drawCircle.js
│       └── drawEllipse.js
├── docs/
│   ├── 使用文档.md            # 用户使用指南
│   └── 开发文档.md            # 架构 / API / 扩展 / 避坑
└── libs/
    ├── Cesium/                # 离线 Cesium
    └── lil-gui.js             # 离线 lil-gui
```

---

## 🧩 扩展开发

新增绘制类型（如三角形）需同步以下位置：

1. **新建模块**：默认导出交互函数，具名导出 Entity 工厂；使用 `_createDrawingShape` 和 `_createInteractionHandler`，完成时调用 `completeShape`。
2. **注册与校验**：核心 `types` 注册表、控制点校验和必要的特殊编辑规则。
3. **测试与入口**：GUI 按钮、绘制/编辑/回显往返测试和文档。

编辑能力（顶点拖拽 / 整体移动 / 右键菜单 / 事件）**自动复用**。

> 详细开发指南与避坑记录见 [开发文档](docs/开发文档.md)。

---

## 生命周期与迁移说明

- `stopDraw()`、切换类型、`clear()`、`destroy()`、点数不足作废会让当前绘制 Promise 以 `AbortError` 拒绝，请在调用处处理；`clearDrawing()` 原地重画，不结算 Promise。初始化参数错误正常抛出/拒绝。
- 事件与完成回调的坐标不再是内部数组引用；修改结果不会影响地图，最新值通过 `getGraphic(id)` 查询。监听器异常记录后不阻断其他监听器。
- `destroy()` 现在完整释放工具资源，移除自建图层，保留外部共享图层；可重复调用，但销毁后不可再绘制、编辑或加载。仅需清空并复用时使用 `clear()`。
- `draw.enableEdit = false` 会立即退出当前编辑并恢复原相机设置。拖拽结束、离开画布和失焦也会恢复相机。
- 空闲图形使用静态属性；控制点按需创建，停止编辑后释放。业务不得直接修改内部 shape 或 Cesium 实体集合。
- 本工具面向局部区域，处理中间点/平移的经度环绕并拒绝越界纬度；圆、椭圆仍为局部近似，不用于极区或全球大范围精确测绘。交互、编辑与回显统一拒绝退化矩形、零半径和非法半轴。
- 绘制同 ID 会在开始时移除本工具旧图形；之后取消不会恢复旧图形。回显仍拒绝任何 ID 冲突。

### 右键菜单样式

菜单挂载于 `document.body`，默认样式使用 `:where()`，普通全局 CSS 即可覆盖，无需 `!important`。Vue 中使用非 scoped 样式；不要覆盖 `position/left/top`。菜单会在视口边缘调整位置。

```css
.x-contextmenu {
  background: #fafafa;
}
.x-contextmenu .x-delete:hover {
  background: #ffdede;
}
```

验证命令：`node tests/graphics.test.mjs`。页面控制台提供 `drawDemo.start(type)`（取消返回 null）及 `drawDemo.destroy()`。

## 📚 文档

- [使用文档](docs/使用文档.md) — 完整使用说明、交互规则、常见问题
- [开发文档](docs/开发文档.md) — 架构分层、API、扩展步骤、开发避坑记录

---

## 🤝 贡献

欢迎提交 Issue 与 PR，建议先阅读 [开发文档](docs/开发文档.md) 了解模块约定。

---

## 📄 License

MIT
