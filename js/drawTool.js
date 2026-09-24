// 引入绘制模块（画线逻辑独立存放，避免本文件代码杂乱）
import drawLineModule, { createLineEntity } from "./modules/drawLine.js";
import drawPointModule, { createPointEntity } from "./modules/drawPoint.js";
import drawRectModule, {
  createRectangleEntity,
  getRectangleCorners,
} from "./modules/drawRect.js";
import drawPolygonModule, {
  createPolygonEntity,
} from "./modules/drawPolygon.js";
import drawCircleModule, { createCircleEntity } from "./modules/drawCircle.js";
import drawEllipseModule, {
  createEllipseEntity,
} from "./modules/drawEllipse.js";

const types = Object.freeze({
  point: { draw: drawPointModule, create: createPointEntity },
  line: { draw: drawLineModule, create: createLineEntity },
  rect: { draw: drawRectModule, create: createRectangleEntity },
  polygon: { draw: drawPolygonModule, create: createPolygonEntity },
  circle: { draw: drawCircleModule, create: createCircleEntity },
  ellipse: { draw: drawEllipseModule, create: createEllipseEntity },
});
const viewerOwners = new WeakMap();
const clonePoints = (points) => points.map((point) => [...point]);
const wrapLongitude = (value) => ((((value + 180) % 360) + 360) % 360) - 180;
const abortError = () =>
  Object.assign(new Error("绘制已取消"), { name: "AbortError" });

export default class DrawTool {
  /**
   * @param {object} viewer - Cesium Viewer 实例
   * @param {object} [config] - 实例配置
   * @param {Cesium.CustomDataSource} [config.dataSource] - 外部图层由调用方管理
   * @param {boolean} [config.enableEdit=true] - 是否支持编辑（false 时禁用所有编辑入口，autoEdit 随之失效）
   * @param {boolean} [config.autoEdit=true] - 绘制完成后是否自动激活编辑（仅在 enableEdit 为 true 时生效）
   * @param {object} [config.style] - 默认样式（lineWidth / color / pointSize / clampToGround）
   *   也可直接传旧写法：{ lineWidth, color, pointSize, clampToGround }
   */
  constructor(viewer, config) {
    this.viewer = viewer;
    this._destroyed = false;
    this._revision = 0;
    this._ownsDataSource = !config?.dataSource;
    this._session = null;
    // 外部图层由调用方挂载；默认图层由工具创建并异步挂载
    this.dataSource =
      config?.dataSource ?? new Cesium.CustomDataSource("x-draw-layer");
    this.ready = (
      config?.dataSource
        ? Promise.resolve(this.dataSource)
        : Promise.resolve(viewer.dataSources.add(this.dataSource))
    ).then((layer) => {
      if (this._destroyed && this._ownsDataSource)
        viewer.dataSources.remove(layer);
      return layer;
    });
    const entities = this.dataSource.entities;
    const owned = new Set();
    // 所有实体（包括预览、标签、编辑辅助点）共用同一所有权边界
    this._ownedEntities = {
      snapshot: () => new Set(owned),
      add: (options) => {
        const entity = entities.add(options);
        owned.add(entity);
        return entity;
      },
      remove: (entity) => {
        if (!owned.delete(entity)) return false;
        return entities.remove(entity);
      },
      getById: (id) => {
        const entity = entities.getById(id);
        if (entity && !owned.has(entity)) {
          throw new Error(`实体 id "${id}" 已被图层中的其他业务对象使用`);
        }
        return entity;
      },
      removeById: (id) =>
        this._ownedEntities.remove(this._ownedEntities.getById(id)),
      removeAll: () => {
        for (const entity of [...owned]) this._ownedEntities.remove(entity);
      },
    };
    const style = config?.style || {};
    this.defaultStyle = {
      // 默认样式：style 优先，其次兼容旧写法直接字段
      lineWidth: style.lineWidth ?? config?.lineWidth ?? 2,
      color: style.color ?? config?.color ?? "#00ffff",
      pointSize: style.pointSize ?? config?.pointSize ?? 10,
      // 是否贴地（线 / 矩形 / 多边形 / 圆 / 椭圆），默认 false 不贴地
      clampToGround: style.clampToGround ?? config?.clampToGround ?? false,
    };
    // 是否支持编辑（默认 true）；为 false 时禁用所有编辑入口，autoEdit 随之失效
    this.enableEdit = config?.enableEdit ?? true;
    // 绘制完成后是否自动激活编辑（默认 true，仅在 enableEdit 为 true 时生效）
    this.autoEdit = config?.autoEdit ?? true;
    this.interactionHandler = null; // 当前绘制 / 编辑的事件处理器
    this.idleHandler = null; // 空闲状态下的"点击激活编辑"处理器
    this.shapes = []; // 所有已绘制完成的实体数据（线 / 点 / 面）
    this.drawingShape = null; // 正在绘制的实体数据
    this.editingShape = null; // 正在编辑的实体数据
    this.label = null; // 经纬度 / 悬停提示标签
    this.contextMenu = null; // 右键菜单 DOM
    this.closeContextMenuHandler = () => this.hideContextMenu(); // 关闭右键菜单的处理器
    this._events = new Map();
    const input = viewer.cesiumWidget.screenSpaceEventHandler;
    let owner = viewerOwners.get(viewer);
    if (!owner) {
      owner = {
        count: 0,
        action: input.getInputAction?.(
          Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
        ),
      };
      viewerOwners.set(viewer, owner);
      input.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    }
    owner.count++;
  }

  /**
   * 图层的兼容访问入口，与公开属性 dataSource 指向同一对象。
   * 支持通过 draw._dataSource.show 控制图层显隐。
   */
  get _dataSource() {
    return this.dataSource;
  }

  // ======================= 公共工具方法（画点、画面等后续复用） =======================

  /**
   * 屏幕坐标 → 经纬度 [lon, lat]；未命中地面返回 null
   * @param {Cesium.Cartesian2} screenPosition - 屏幕坐标
   * @returns {Array|null} [lon, lat]
   */
  pickLonLat(screenPosition) {
    const scene = this.viewer.scene;
    // 优先与真实地形求交（有起伏时更精确），无命中回退椭球
    const ray = scene.camera.getPickRay(screenPosition);
    const cartesian =
      (ray && scene.globe.pick(ray, scene)) ||
      scene.camera.pickEllipsoid(screenPosition);
    if (!cartesian) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    return [
      Cesium.Math.toDegrees(carto.longitude),
      Cesium.Math.toDegrees(carto.latitude),
    ];
  }

  /**
   * 坐标点数组 [[lon, lat], ...] → Cartesian3 数组
   * @param {Array} points - 坐标点数组
   * @returns {Cesium.Cartesian3[]}
   */
  positionsToCartesian(points) {
    return (points || []).map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1]));
  }

  /**
   * 创建点实体
   * @param {Array} position - [lon, lat]
   * @param {object} [options] - 样式配置
   * @param {number} [options.size] - 点大小
   * @param {string} [options.color] - 颜色
   * @param {boolean} [options.outline] - 是否白色描边（编辑样式）
   * @param {string} [options.id] - 自定义实体 id（可选）
   * @returns {Cesium.Entity}
   */
  createPointEntity(position, options = {}) {
    const size = options.size ?? this.defaultStyle.pointSize;
    const color = options.color ?? this.defaultStyle.color;
    const outline = options.outline ?? false;
    const clampToGround = options.clampToGround ?? false;
    const { id } = options;
    const point = {
      pixelSize: size,
      color: Cesium.Color.fromCssColorString(color),
      outlineWidth: outline ? 2 : 0,
      zIndex: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    };
    if (outline) {
      point.outlineColor = Cesium.Color.WHITE;
    }
    // 贴地形状的辅助点也夹取到地面，才能与贴地的边框线重合
    if (clampToGround) {
      point.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
    }
    return this._ownedEntities.add({
      id, // 传了 id 则指定实体 id，不传由 Cesium 自动生成
      position: Cesium.Cartesian3.fromDegrees(position[0], position[1]),
      point,
    });
  }

  /**
   * 创建线实体（实线 / 虚线）
   * positions 使用 CallbackProperty 引用 points 数组，直接修改数组即可自动更新；
   * 也可通过 options.positions 传入自定义回调（如临时预览虚线返回 previewPosition）
   * @param {Array} points - 坐标点数组
   * @param {object} [style] - { lineWidth, color, clampToGround }
   * @param {object} [options] - { dash: 是否虚线, positions: 自定义 positions 回调, id: 自定义实体 id }
   * @returns {Cesium.Entity}
   */
  createPolylineEntity(points, style = {}, options = {}) {
    const lineWidth = style.lineWidth ?? this.defaultStyle.lineWidth;
    const color = style.color ?? this.defaultStyle.color;
    const clampToGround =
      style.clampToGround ?? this.defaultStyle.clampToGround;
    const { dash = false, positions, id } = options;
    const polyline = {
      positions: new Cesium.CallbackProperty(
        typeof positions === "function"
          ? positions
          : () => this.positionsToCartesian(points),
        false,
      ),
      width: lineWidth,
      ...(clampToGround ? { zIndex: 1 } : {}),
      // 是否贴地：由 style.clampToGround 控制（默认 false 不贴地）
      clampToGround,
    };
    if (dash) {
      polyline.material = new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString(color), // 虚线实色，不透明
        dashLength: 20,
      });
    } else {
      polyline.material = Cesium.Color.fromCssColorString(color);
    }
    // 传了 id 则指定实体 id，不传由 Cesium 自动生成
    return this._ownedEntities.add({ id, polyline });
  }

  /**
   * 创建面实体（多边形 / 矩形）
   * hierarchy 使用 CallbackProperty 引用 points 数组，直接修改数组即可自动更新；
   * 也可通过 options.positions 传入自定义回调（如预览矩形用鼠标位置实时计算）
   * @param {Array} points - 坐标点数组 [[lon, lat], ...]
   * @param {object} [style] - { color, clampToGround }
   * @param {object} [options] - { id: 自定义实体 id, positions: 自定义 hierarchy 回调 }
   * @returns {Cesium.Entity}
   */
  createPolygonEntity(points, style = {}, options = {}) {
    const color = style.color ?? this.defaultStyle.color;
    const clampToGround =
      style.clampToGround ?? this.defaultStyle.clampToGround;
    const { id, positions } = options;
    const polygon = {
      hierarchy: new Cesium.CallbackProperty(() => {
        const p = typeof positions === "function" ? positions() : points;
        return new Cesium.PolygonHierarchy(this.positionsToCartesian(p));
      }, false),
      material: Cesium.Color.fromCssColorString(color).withAlpha(0.5), // 半透明填充
    };
    // clampToGround=true：不设置 height，由 GroundPrimitive 自动夹取到地面（不支持 outline）
    if (!clampToGround) {
      // 不贴地：显式设置高度 0，禁用地形夹取，启用轮廓线
      polygon.outline = true;
      polygon.outlineColor = Cesium.Color.fromCssColorString(color);
      polygon.outlineWidth = 2;
      polygon.height = 0;
      // 注意：有 height 时 Cesium 不支持 zIndex，故不设置
    }
    return this._ownedEntities.add({
      id, // 传了 id 则指定实体 id，不传由 Cesium 自动生成
      polygon,
    });
  }

  /**
   * 创建椭圆 / 圆实体
   * position / semiMajorAxis / semiMinorAxis / rotation 均支持函数（自动转 CallbackProperty），
   * 实现"绘制预览 / 完成固定 / 编辑拖拽"全程自动更新
   * @param {Array} center - 中心点 [lon, lat]（仅作默认值）
   * @param {object} [style] - { color, clampToGround }
   * @param {object} [options] - { id, position, semiMajorAxis, semiMinorAxis, rotation }
   * @returns {Cesium.Entity}
   */
  createEllipseEntity(center, style = {}, options = {}) {
    const color = style.color ?? this.defaultStyle.color;
    const clampToGround =
      style.clampToGround ?? this.defaultStyle.clampToGround;
    const { id, position, semiMajorAxis, semiMinorAxis, rotation } = options;
    const toProp = (v) =>
      typeof v === "function" ? new Cesium.CallbackProperty(v, false) : v;
    const ellipse = {
      semiMajorAxis: toProp(semiMajorAxis),
      semiMinorAxis: toProp(semiMinorAxis),
      rotation: toProp(rotation),
      material: Cesium.Color.fromCssColorString(color).withAlpha(0.5), // 半透明填充
    };
    // clampToGround=true：不设置 height，由 GroundPrimitive 自动夹取到地面（不支持 outline）
    if (!clampToGround) {
      // 不贴地：显式设置高度 0，禁用地形夹取，启用轮廓线
      ellipse.outline = true;
      ellipse.outlineColor = Cesium.Color.fromCssColorString(color);
      ellipse.outlineWidth = 2;
      ellipse.height = 0;
    }
    return this._ownedEntities.add({
      id, // 传了 id 则指定实体 id，不传由 Cesium 自动生成
      position:
        typeof position === "function"
          ? new Cesium.CallbackPositionProperty(position, false)
          : (position ?? Cesium.Cartesian3.fromDegrees(center[0], center[1])),
      ellipse,
    });
  }

  /**
   * 锁定相机操作（拖拽编辑时禁用旋转 / 平移 / 缩放）
   */
  lockCamera() {
    if (this._cameraState) return;
    const controller = this.viewer.scene.screenSpaceCameraController;
    this._cameraState = {};
    for (const key of [
      "enableRotate",
      "enableTranslate",
      "enableZoom",
      "enableTilt",
      "enableLook",
    ]) {
      this._cameraState[key] = controller[key];
      controller[key] = false;
    }
  }

  /**
   * 恢复相机操作
   */
  unlockCamera() {
    if (!this._cameraState) return;
    Object.assign(
      this.viewer.scene.screenSpaceCameraController,
      this._cameraState,
    );
    this._cameraState = null;
  }

  /**
   * 根据拾取的实体查找所属 shape
   * @param {object} feature - scene.pick 的结果
   * @returns {object|null}
   */
  findShapeByFeature(feature) {
    if (!Cesium.defined(feature)) return null;
    return this.shapes.find(
      (s) =>
        s.mainEntity === feature.id ||
        s.controlPointEntities.includes(feature.id) ||
        s.translationHandleEntity === feature.id ||
        (s.midpointEntities && s.midpointEntities.includes(feature.id)),
    );
  }

  /**
   * 更新形状的顶点实体位置（整体拖拽后同步显示）
   * 矩形特殊：4 个角点由对角点推导；其他形状顶点与 points 一一对应
   * @param {object} shape - 实体数据
   */
  _updateVertexEntities(shape) {
    if (shape.type === "rect" && shape.controlPoints.length === 2) {
      // 矩形：由对角点推导 4 个角点
      const [a, b] = shape.controlPoints;
      const corners = [
        [a[0], a[1]],
        [b[0], a[1]],
        [b[0], b[1]],
        [a[0], b[1]],
      ];
      shape.controlPointEntities.forEach((entity, i) => {
        entity.position.setValue(
          Cesium.Cartesian3.fromDegrees(corners[i][0], corners[i][1]),
        );
      });
      return;
    }
    // 其他形状：顶点实体与 points 一一对应
    shape.controlPointEntities.forEach((entity, i) => {
      const p = shape.controlPoints[i];
      if (p) {
        entity.position.setValue(Cesium.Cartesian3.fromDegrees(p[0], p[1]));
      }
    });
  }

  /**
   * 计算形状的中心点（用于整体拖拽平移）
   * 圆 / 椭圆：points[0] 即圆心；其他形状：所有顶点的算术平均值
   * @param {object} shape - 实体数据
   * @returns {Array} [lon, lat]
   */
  _getTranslationCenter(shape) {
    const points = shape.controlPoints;
    if (!points || points.length === 0) return [0, 0];
    // 圆和椭圆的 points[0] 就是圆心
    if (shape.type === "circle" || shape.type === "ellipse") {
      return [points[0][0], points[0][1]];
    }
    let sumLon = 0;
    let sumLat = 0;
    points.forEach((p) => {
      sumLon += points[0][0] + wrapLongitude(p[0] - points[0][0]);
      sumLat += p[1];
    });
    return [wrapLongitude(sumLon / points.length), sumLat / points.length];
  }

  /**
   * 更新中心点实体位置（拖拽顶点 / 整体移动后调用）
   * @param {object} shape - 实体数据
   */
  _updateCenterEntity(shape) {
    if (!shape.translationHandleEntity) return;
    const center = this._getTranslationCenter(shape);
    shape.translationHandleEntity.position.setValue(
      Cesium.Cartesian3.fromDegrees(center[0], center[1]),
    );
  }

  /**
   * 计算两个坐标点的中点
   * @param {Array} a - [lon, lat]
   * @param {Array} b - [lon, lat]
   * @returns {Array} [lon, lat]
   */
  _getMidpoint(a, b) {
    return [
      wrapLongitude(a[0] + wrapLongitude(b[0] - a[0]) / 2),
      (a[1] + b[1]) / 2,
    ];
  }

  // 两点线段的插点手柄避开平移中心，创建、更新和拾取回退共用此位置。
  _getInsertionHandlePosition(shape, index) {
    const points = shape.controlPoints;
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const midpoint = this._getMidpoint(a, b);
    return shape.type === "line" && points.length === 2
      ? this._getMidpoint(a, midpoint)
      : midpoint;
  }

  /**
   * 创建 / 重建中间点实体（仅线 / 多边形）
   * 线：每两个相邻顶点之间 1 个中间点（不闭合）
   * 多边形：每两个相邻顶点之间 1 个中间点（闭合，末尾→首项）
   * @param {object} shape - 实体数据
   */
  _createMidpoints(shape) {
    if (shape.type !== "line" && shape.type !== "polygon") return;
    this._clearMidpoints(shape);
    shape.midpointEntities = [];
    const pts = shape.controlPoints;
    if (pts.length < 2) return;
    const count = shape.type === "polygon" ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const mid = this._getInsertionHandlePosition(shape, i);
      const entity = this._ownedEntities.add({
        position: Cesium.Cartesian3.fromDegrees(mid[0], mid[1]),
        point: {
          pixelSize: Math.max(shape.style.pointSize - 4, 4),
          color: Cesium.Color.fromCssColorString(shape.style.color).withAlpha(
            0.35,
          ),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // 贴地形状的中间点也夹取到地面，与贴地边框线重合
          heightReference: shape.style.clampToGround
            ? Cesium.HeightReference.CLAMP_TO_GROUND
            : Cesium.HeightReference.NONE,
        },
      });
      shape.midpointEntities.push(entity);
    }
  }

  /**
   * 更新中间点位置（顶点拖拽 / 整体平移后调用）
   * 如果点数变化导致中间点数量不匹配，则重建
   * @param {object} shape - 实体数据
   */
  _updateMidpoints(shape) {
    if (shape.type !== "line" && shape.type !== "polygon") return;
    if (!shape.midpointEntities || shape.midpointEntities.length === 0) {
      this._createMidpoints(shape);
      return;
    }
    const pts = shape.controlPoints;
    const expectedCount =
      shape.type === "polygon" ? pts.length : Math.max(pts.length - 1, 0);
    if (shape.midpointEntities.length !== expectedCount) {
      // 数量变化，重建
      this._createMidpoints(shape);
      return;
    }
    for (let i = 0; i < expectedCount; i++) {
      const mid = this._getInsertionHandlePosition(shape, i);
      shape.midpointEntities[i].position.setValue(
        Cesium.Cartesian3.fromDegrees(mid[0], mid[1]),
      );
    }
  }

  /**
   * 清除所有中间点实体
   * @param {object} shape - 实体数据
   */
  _clearMidpoints(shape) {
    if (!shape.midpointEntities) return;
    shape.midpointEntities.forEach((entity) => {
      this._ownedEntities.remove(entity);
    });
    shape.midpointEntities = [];
  }

  // ======================= 事件系统 =======================

  /**
   * 注册事件监听
   * 用法：draw.on("editMovePoint", (data) => { ... })，data 为 { id, positions, type }
   * @param {string} eventName - 事件名（如 "editStart" 开始编辑 / "editMovePoint" 编辑完点 / "editStop" 结束编辑 / "removeGraphic" 删除实体）
   * @param {Function} callback - 回调，收到独立坐标快照；监听器异常记录后不阻断其他监听器
   * @returns {this} 支持链式调用
   */
  on(eventName, callback) {
    if (typeof callback !== "function") return this;
    this._assertAlive();
    if (!this._events.has(eventName)) this._events.set(eventName, []);
    this._events.get(eventName).push(callback);
    return this;
  }

  /**
   * 移除事件监听
   * @param {string} eventName - 事件名
   * @param {Function} [callback] - 要移除的回调，不传则移除该事件所有回调
   * @returns {this} 支持链式调用
   */
  off(eventName, callback) {
    const list = this._events.get(eventName);
    if (!list) return this;
    if (!callback) {
      this._events.delete(eventName);
      return this;
    }
    const index = list.indexOf(callback);
    if (index !== -1) list.splice(index, 1);
    return this;
  }

  /**
   * 触发事件（内部使用）
   * @param {string} eventName - 事件名
   * @param {*} data - 传给回调的数据
   */
  emit(eventName, data) {
    const list = this._events.get(eventName);
    if (!list) return;
    [...list].forEach((callback) => {
      try {
        const payload = data?.positions
          ? { ...data, positions: clonePoints(data.positions) }
          : data;
        const result = callback(payload);
        if (result?.then)
          Promise.resolve(result).catch((error) => console.error(error));
      } catch (error) {
        console.error(error);
      }
    });
  }

  /**
   * 构造实体结果对象 { id, positions, type }（内部使用，回调 / 事件共用）
   * positions 为独立快照；需要最新数据请调用 getGraphic(id)。
   * 矩形内部存对角点，对外返回推导出的 4 个角点
   * @param {object} shape - 实体数据
   * @returns {object} { id, positions, type }
   */
  _buildGraphicResult(shape) {
    let positions = shape.controlPoints;
    if (shape.type === "rect" && shape.controlPoints.length === 2) {
      const [a, b] = shape.controlPoints;
      positions = [
        [a[0], a[1]],
        [b[0], a[1]],
        [b[0], b[1]],
        [a[0], b[1]],
      ];
    }
    return {
      id: shape.mainEntity?.id ?? shape.id, // 实体 id
      positions: clonePoints(positions), // 本次操作的独立快照
      type: shape.type, // 绘制类型
    };
  }

  /**
   * 绘制初始化完成后通知外部；点和矩形提前分配正式实体 id。
   * 开始事件使用坐标快照，避免后续加点改变开始时的数据。
   */
  _emitDrawStart(shape) {
    shape.id = shape.mainEntity?.id ?? shape.id ?? Cesium.createGuid();
    const result = this._buildGraphicResult(shape);
    this.emit("drawStart", {
      ...result,
      positions: result.positions.map((point) => [...point]),
    });
  }

  // ======================= 数据导出与静默回显 =======================

  /** 导出单个已完成图形的独立快照，未找到返回 null。 */
  getGraphic(id) {
    const shape = this.shapes.find((item) => item.mainEntity.id === id);
    if (!shape) return null;
    return this._serializeShape(shape);
  }

  _serializeShape(shape) {
    const result = this._buildGraphicResult(shape);
    return {
      ...result,
      positions: result.positions.map((point) => [...point]),
      style: {
        lineWidth: shape.style.lineWidth,
        color: shape.style.color,
        pointSize: shape.style.pointSize,
        clampToGround:
          shape.type === "point" ? false : shape.style.clampToGround,
      },
    };
  }

  /** 导出全部已完成图形，可直接 JSON.stringify 后交给业务层存储。 */
  getGraphics() {
    return this.shapes.map((shape) => this._serializeShape(shape));
  }

  /** 静默追加一个历史图形，不触发绘制事件或自动编辑。 */
  addGraphic(data) {
    return this.loadGraphics([data])[0];
  }

  /** 校验并复制历史数据，返回内部控制点模型。 */
  _normalizeGraphic(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new TypeError("图形数据必须是对象");
    }
    const { type } = data;
    // 未提供 id 时生成唯一标识；显式传入的非法 id 仍由下方校验拒绝。
    const id = data.id === undefined ? Cesium.createGuid() : data.id;
    const counts = {
      point: [1, 1],
      line: [2, Infinity],
      rect: [2, 4],
      polygon: [3, Infinity],
      circle: [2, 2],
      ellipse: [3, 3],
    };
    if (typeof id !== "string" || !id.trim())
      throw new TypeError("图形 id 必须是非空字符串");
    if (!Object.hasOwn(counts, type))
      throw new TypeError(`不支持的图形类型：${type}`);
    if (!Array.isArray(data.positions))
      throw new TypeError(`${id}: positions 必须是数组`);
    let points = Array.from(data.positions, (point) => {
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1]) ||
        Math.abs(point[0]) > 180 ||
        Math.abs(point[1]) > 90
      ) {
        throw new TypeError(`${id}: 坐标必须是合法的 [经度, 纬度]`);
      }
      return [...point];
    });
    const [min, max] = counts[type];
    if (
      points.length < min ||
      points.length > max ||
      (type === "rect" && points.length === 3)
    ) {
      throw new RangeError(`${id}: ${type} 控制点数量不正确`);
    }
    const same = (a, b) => wrapLongitude(a[0] - b[0]) === 0 && a[1] === b[1];
    if (
      (type === "line" || type === "polygon") &&
      points.some((point, i) => i > 0 && same(point, points[i - 1]))
    ) {
      throw new RangeError(`${id}: 相邻控制点不能重合`);
    }
    if (type === "polygon" && same(points[0], points.at(-1))) {
      throw new RangeError(`${id}: 多边形不应重复首点`);
    }
    if (type === "rect") {
      if (points.length === 4) {
        const expected = getRectangleCorners(points[0], points[2]);
        if (!points.every((point, i) => same(point, expected[i]))) {
          throw new RangeError(`${id}: 矩形四角须使用 getGraphic 导出的顺序`);
        }
        points = [points[0], points[2]];
      }
      if (
        wrapLongitude(points[0][0] - points[1][0]) === 0 ||
        points[0][1] === points[1][1]
      ) {
        throw new RangeError(`${id}: 矩形宽高不能为零`);
      }
    }
    if (type === "circle" || type === "ellipse") {
      const center = Cesium.Cartesian3.fromDegrees(...points[0]);
      const axes = points
        .slice(1)
        .map((point) =>
          Cesium.Cartesian3.distance(
            center,
            Cesium.Cartesian3.fromDegrees(...point),
          ),
        );
      if (
        axes.some((axis) => axis <= 0) ||
        (type === "ellipse" && axes[1] > axes[0])
      ) {
        throw new RangeError(`${id}: 半轴必须大于零，椭圆短轴不得大于长轴`);
      }
    }
    const style = this._normalizeStyle(data.style);
    if (type === "point") style.clampToGround = false;
    return {
      id,
      type,
      controlPoints: points,
      style,
      controlPointEntities: [],
      mainEntity: null,
      previewPosition: null,
    };
  }

  /** 批量追加历史图形：预校验、静默创建，失败时回滚本批次。 */
  loadGraphics(dataList) {
    this._assertAlive();
    if (
      this.drawingShape ||
      this.editingShape ||
      this.editing ||
      this._loadingGraphics
    ) {
      throw new Error("请先结束当前绘制或编辑，再加载历史图形");
    }
    if (!Array.isArray(dataList)) throw new TypeError("历史图形列表必须是数组");
    const shapes = Array.from(dataList, (data) => this._normalizeGraphic(data));
    const ids = new Set(this.shapes.map((shape) => shape.mainEntity.id));
    for (const shape of shapes) {
      if (ids.has(shape.id) || this.dataSource.entities.getById(shape.id)) {
        throw new Error(`图形 id "${shape.id}" 已存在，回显不覆盖已有实体`);
      }
      ids.add(shape.id);
    }
    if (!shapes.length) return [];
    const before = this._ownedEntities.snapshot();
    const count = this.shapes.length;
    const idleBefore = this.idleHandler;

    this._loadingGraphics = true;
    try {
      for (const shape of shapes) {
        types[shape.type].create(this, shape);
        this._registerShape(shape);
      }
      this.setupIdleHandler();
      return shapes.map((shape) => this._serializeShape(shape));
    } catch (error) {
      for (const entity of this._ownedEntities.snapshot()) {
        if (!before.has(entity)) this._ownedEntities.remove(entity);
      }
      this.shapes.splice(count);
      if (!idleBefore && this.idleHandler) {
        this.idleHandler.destroy();
        this.idleHandler = null;
      }
      throw error;
    } finally {
      this._loadingGraphics = false;
    }
  }

  // ======================= 绘制入口 =======================

  /**
   * 开始绘制（统一入口）
   * 支持两种调用方式：
   * 1. 回调：draw.startDraw({ id, type, style, success: cb })
   * 2. 异步：draw.startDraw({ id, type, style }).then(cb)
   * @param {object} options - 绘制配置
   * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
   * @param {string} options.type - line / point / rect / polygon / circle / ellipse
   * @param {object} [options.style] - 样式配置（lineWidth / color / pointSize / clampToGround）
   * @param {Function} [options.success] - 绘制完成后的回调（可选，与 Promise 二选一）
   * @returns {Promise|undefined} 完成时返回快照；取消以 AbortError 拒绝，初始化错误以原始错误拒绝。回调模式返回 undefined。
   */
  startDraw(options = {}) {
    if (typeof options?.success === "function") {
      this._startDrawing(options);
      return;
    }
    return new Promise((resolve, reject) => {
      this._startDrawing({ ...options, success: resolve }, reject);
    });
  }

  _startDrawing(options, reject) {
    this._assertAlive();
    const { type } = options;
    if (!Object.hasOwn(types, type))
      throw new TypeError(`不支持的图形类型：${type}`);
    const id = options.id ?? Cesium.createGuid();
    if (options.id === null || typeof id !== "string" || !id.trim())
      throw new TypeError("图形 id 必须是非空字符串");
    const style = this._normalizeStyle(options.style);
    this._ownedEntities.getById(id);
    const revision = ++this._revision;
    this.stopDraw();
    this.stopEditing();
    if (this._destroyed || this._revision !== revision) {
      reject?.(abortError());
      return;
    }
    this.hideContextMenu();
    const session = { reject, success: options.success };
    this._session = session;
    const before = this._ownedEntities.snapshot();
    try {
      const previous = this.shapes.find((shape) => shape.mainEntity.id === id);
      if (previous) this.removeGraphic(previous);
      if (this._session !== session || this._destroyed) return;
      types[type].draw(this, { ...options, id, style, success: undefined });
    } catch (error) {
      if (this._session === session) {
        session.reject?.(error);
        this.stopDraw();
        for (const entity of this._ownedEntities.snapshot()) {
          if (!before.has(entity)) this._ownedEntities.remove(entity);
        }
      }
      throw error;
    }
  }

  _normalizeStyle(source = {}) {
    if (!source || typeof source !== "object" || Array.isArray(source))
      throw new TypeError("style 必须是对象");
    const style = { ...this.defaultStyle, ...source };
    for (const key of Object.keys(this.defaultStyle)) {
      if (source[key] === undefined) style[key] = this.defaultStyle[key];
    }
    if (
      !Number.isFinite(style.lineWidth) ||
      style.lineWidth <= 0 ||
      !Number.isFinite(style.pointSize) ||
      style.pointSize <= 0 ||
      typeof style.clampToGround !== "boolean" ||
      typeof style.color !== "string" ||
      !Cesium.Color.fromCssColorString(style.color)
    )
      throw new TypeError("样式中的颜色、尺寸或贴地配置无效");
    return style;
  }

  // ======================= 画线 =======================

  /**
   * 画线：支持绘制多条线，每次调用都是一条独立的新线
   * 具体交互逻辑见 js/modules/drawLine.js
   * @param {object} options - 画线参数
   * @param {Array} [options.data] - 初始坐标点（[[lon, lat], ...]），空数组表示交互绘制
   * @param {object} [options.style] - 样式（lineWidth / color / pointSize）
   * @param {Function} [options.success] - 绘制完成回调，返回 { id, positions, type } 快照
   */
  drawLine(options) {
    this._startDrawing({ ...options, type: "line" });
  }

  /**
   * 画点：单击放置一个点
   * 具体交互逻辑见 js/modules/drawPoint.js
   * @param {object} options - 画点参数
   * @param {string} [options.id] - 自定义实体 id（可选）
   * @param {object} [options.style] - 样式（lineWidth / color / pointSize）
   * @param {Function} [options.success] - 绘制完成回调，返回 { id, positions, type }
   */
  drawPoint(options) {
    this._startDrawing({ ...options, type: "point" });
  }

  /**
   * 画矩形：两个对角点确定矩形
   * 具体交互逻辑见 js/modules/drawRect.js
   * @param {object} options - 画矩形参数
   * @param {string} [options.id] - 自定义实体 id（可选）
   * @param {object} [options.style] - 样式（lineWidth / color / pointSize）
   * @param {Function} [options.success] - 绘制完成回调，返回 { id, positions, type }
   */
  drawRect(options) {
    this._startDrawing({ ...options, type: "rect" });
  }

  /**
   * 画多边形：多顶点闭合面，双击结束
   * 具体交互逻辑见 js/modules/drawPolygon.js
   * @param {object} options - 画多边形参数
   * @param {string} [options.id] - 自定义实体 id（可选）
   * @param {Array} [options.data] - 初始顶点坐标（可选）
   * @param {object} [options.style] - 样式（lineWidth / color / pointSize）
   * @param {Function} [options.success] - 绘制完成回调，返回 { id, positions, type }
   */
  drawPolygon(options) {
    this._startDrawing({ ...options, type: "polygon" });
  }

  /**
   * 画圆：圆心 + 半径点
   * 具体交互逻辑见 js/modules/drawCircle.js
   * @param {object} options - 画圆参数
   * @param {string} [options.id] - 自定义实体 id（可选）
   * @param {object} [options.style] - 样式（lineWidth / color / pointSize）
   * @param {Function} [options.success] - 绘制完成回调，返回 { id, positions, type }
   */
  drawCircle(options) {
    this._startDrawing({ ...options, type: "circle" });
  }

  /**
   * 画椭圆：圆心 + 长半轴点 + 短半轴点
   * 具体交互逻辑见 js/modules/drawEllipse.js
   * @param {object} options - 画椭圆参数
   * @param {string} [options.id] - 自定义实体 id（可选）
   * @param {object} [options.style] - 样式（lineWidth / color / pointSize）
   * @param {Function} [options.success] - 绘制完成回调，返回 { id, positions, type }
   */
  drawEllipse(options) {
    this._startDrawing({ ...options, type: "ellipse" });
  }

  /**
   * 静默登记：释放辅助点、固定主实体属性并保存内部模型
   * 绘制完成回调返回：{ id, positions, type }
   * @param {object} shape - 实体数据
   */
  _registerShape(shape) {
    this._releaseEditHandles(shape);
    this._setDynamic(shape, false);
    this.shapes.push(shape);
    this.viewer.scene.requestRender?.();
  }

  _releaseEditHandles(shape) {
    for (const entity of shape.controlPointEntities) {
      if (entity !== shape.mainEntity) this._ownedEntities.remove(entity);
      else entity.point.outlineWidth = 0;
    }
    shape.controlPointEntities =
      shape.type === "point" ? [shape.mainEntity] : [];
    this._ownedEntities.remove(shape.translationHandleEntity);
    shape.translationHandleEntity = null;
    this._clearMidpoints(shape);
  }

  _createEditHandles(shape) {
    if (shape.type === "point") return;
    const points =
      shape.type === "rect"
        ? getRectangleCorners(...shape.controlPoints)
        : shape.controlPoints;
    shape.controlPointEntities = points.map((point) =>
      this._createControlPoint(shape, point),
    );
    shape.translationHandleEntity = this.createPointEntity(
      this._getTranslationCenter(shape),
      {
        size: shape.style.pointSize,
        color: "#ff9800",
        outline: true,
        clampToGround: shape.style.clampToGround,
      },
    );
  }

  _createControlPoint(shape, point) {
    return this.createPointEntity(point, {
      size: Math.max(shape.style.pointSize - 4, 4),
      color: shape.style.color,
      outline: false,
      clampToGround: shape.style.clampToGround,
    });
  }

  // 保存动态属性绑定，空闲时固定为常量，编辑时恢复原绑定。
  _setDynamic(shape, dynamic) {
    if (!shape._dynamicProperties) {
      const entity = shape.mainEntity;
      shape._dynamicProperties = [];
      const collect = (target, keys) => {
        if (!target) return;
        for (const key of keys) {
          const property = target[key];
          if (property && property.isConstant === false)
            shape._dynamicProperties.push({ target, key, property });
        }
      };
      collect(entity, ["position"]);
      collect(entity.polyline, ["positions"]);
      collect(entity.polygon, ["hierarchy"]);
      collect(entity.ellipse, ["semiMajorAxis", "semiMinorAxis", "rotation"]);
    }
    const time = this.viewer.clock?.currentTime ?? Cesium.JulianDate.now();
    for (const { target, key, property } of shape._dynamicProperties) {
      target[key] = dynamic ? property : property.getValue(time);
    }
    this.viewer.scene.requestRender?.();
  }

  _createInteractionHandler() {
    const handler = new Cesium.ScreenSpaceEventHandler(
      this.viewer.scene.canvas,
    );
    const setInputAction = handler.setInputAction.bind(handler);
    handler.setInputAction = (callback, type) =>
      setInputAction((event) => {
        if (this._destroyed) return;
        try {
          callback(event);
        } catch (error) {
          if (this.drawingShape) {
            this._session?.reject?.(error);
            this.stopDraw();
          }
          console.error(error);
        } finally {
          this.viewer.scene.requestRender?.();
        }
      }, type);
    return handler;
  }

  _createDrawingShape(type, { id, data = [], style }) {
    const shape = {
      type,
      id,
      controlPoints: clonePoints(data),
      style,
      controlPointEntities: [],
      mainEntity: null,
      previewEntity: null,
      previewLineEntity: null,
      previewPosition: null,
      firstPointTime: null,
    };
    if (data.length && !this._isValidShape(shape))
      throw new TypeError("初始控制点无效");
    this.drawingShape = shape;
    this._cursorBefore = document.body.style.cursor;
    document.body.style.cursor = "crosshair";
    return shape;
  }

  _isValidShape(shape) {
    try {
      this._normalizeGraphic({
        id: shape.id,
        type: shape.type,
        positions: shape.controlPoints,
        style: shape.style,
      });
      return true;
    } catch {
      return false;
    }
  }

  _canAddPoint(shape, point) {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !point.every(Number.isFinite) ||
      Math.abs(point[0]) > 180 ||
      Math.abs(point[1]) > 90
    )
      return false;
    const points = [...shape.controlPoints, point];
    if (
      points.length > 1 &&
      points.at(-2).every((value, i) => value === point[i])
    )
      return false;
    if (
      shape.type === "polygon" &&
      points.length > 2 &&
      points[0].every((value, i) => value === point[i])
    )
      return false;
    if (
      shape.type === "ellipse" &&
      points.length === 2 &&
      points[0].every((value, i) => value === point[i])
    )
      return false;
    const count = { point: 1, rect: 2, circle: 2, ellipse: 3 }[shape.type];
    return (
      !count ||
      points.length < count ||
      this._isValidShape({ ...shape, controlPoints: points })
    );
  }

  _moveControlPoint(shape, index, point) {
    const previous = clonePoints(shape.controlPoints);
    if (shape.updatePoint) shape.updatePoint(index, point);
    else shape.controlPoints[index] = [...point];
    if (!this._isValidShape(shape))
      shape.controlPoints.splice(0, shape.controlPoints.length, ...previous);
    this._updateVertexEntities(shape);
    this._updateCenterEntity(shape);
    this._updateMidpoints(shape);
    this.viewer.scene.requestRender?.();
  }

  // 交互绘制保留原有完成事件、回调及自动编辑流程
  completeShape(shape) {
    if (this.drawingShape !== shape) return;
    if (!this._isValidShape(shape)) return;
    const session = this._session;
    this._registerShape(shape);
    this._session = null;
    this.setupIdleHandler();
    this.drawingShape = null;
    this._destroyInteractionHandler();
    const revision = this._revision;
    const result = this._buildGraphicResult(shape);
    // 完成状态清理后触发事件，允许监听器安全地开始下一次绘制。
    this.emit("drawEnd", result);
    try {
      const returned = session?.success?.({
        ...result,
        positions: clonePoints(result.positions),
      });
      if (returned?.then)
        Promise.resolve(returned).catch((error) => console.error(error));
    } catch (error) {
      console.error(error);
    }
    // 根据配置决定是否自动激活编辑（需 enableEdit 且 autoEdit，二者默认均为 true）
    if (
      !this._destroyed &&
      revision === this._revision &&
      this.enableEdit &&
      this.autoEdit &&
      !this.drawingShape &&
      !this.editingShape &&
      this.shapes.includes(shape)
    ) {
      this.startEditing(shape);
    }
  }

  // ======================= 空闲监听（悬停提示 / 激活编辑 / 右键菜单） =======================

  /**
   * 空闲状态下的监听（全局只注册一次）：
   * 1. 鼠标悬停到实体上，显示"左键点击进行编辑，右键菜单"提示
   * 2. 左键点击实体，激活该实体的编辑
   * 3. 右键实体，弹出右键菜单（编辑 / 删除）
   */
  setupIdleHandler() {
    if (this._destroyed || this.idleHandler) return;
    this.idleHandler = new Cesium.ScreenSpaceEventHandler(
      this.viewer.scene.canvas,
    );
    // 鼠标移动：悬停检测，命中实体时显示编辑提示
    this.idleHandler.setInputAction((e) => {
      // 绘制中 / 编辑中不处理悬停（避免干扰绘制经纬度标签）
      if (this.drawingShape || this.editing) return;
      const shape = this.findShapeByFeature(
        this.viewer.scene.pick(e.endPosition),
      );
      if (shape) {
        // 命中实体：在鼠标位置显示提示（启用编辑时提示可编辑，否则仅提示右键菜单）
        const lonlat = this.pickLonLat(e.endPosition);
        if (lonlat) {
          this._showTooltip(
            Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
            this.enableEdit ? "左键点击进行编辑，右键菜单" : "右键菜单",
          );
        }
      } else {
        this._hideTooltip();
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    // 左键点击实体：激活编辑（仅在启用编辑时；未启用则忽略点击）
    this.idleHandler.setInputAction((e) => {
      if (!this.enableEdit) return;
      if (this.drawingShape || this.editing) return;
      const shape = this.findShapeByFeature(this.viewer.scene.pick(e.position));
      if (shape) {
        this.startEditing(shape);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    // 右键实体：弹出右键菜单
    this.idleHandler.setInputAction((e) => {
      if (this.drawingShape || this.editing) return;
      const shape = this.findShapeByFeature(this.viewer.scene.pick(e.position));
      if (shape) {
        this.showContextMenu(e.position.x, e.position.y, shape);
      }
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  }

  // ======================= 右键菜单 =======================

  /**
   * 显示右键菜单（编辑 / 删除 或 停止编辑 / 删除）
   * @param {number} x - 屏幕 X 坐标
   * @param {number} y - 屏幕 Y 坐标
   * @param {object} shape - 目标实体数据
   * @param {object} [options] - 额外配置
   * @param {number} [options.vertexIndex] - 右键命中的顶点索引（传入时顶部追加“删除该点”按钮）
   */
  showContextMenu(x, y, shape, options = {}) {
    if (this._destroyed || !this.shapes.includes(shape)) return;
    this.hideContextMenu();
    // 将 canvas 相对坐标转换为 fixed 定位使用的视口坐标
    const rect = this.viewer.scene.canvas.getBoundingClientRect();
    const clientX = rect.left + x;
    const clientY = rect.top + y;
    const { vertexIndex } = options;
    // 当前是否正在编辑该实体：是则显示“停止编辑”，否则显示“开始编辑”
    const isEditing = this.editingShape === shape;
    const menu = document.createElement("div");
    menu.className = "x-contextmenu";
    menu.style.cssText = `
      position: fixed; left: ${clientX}px; top: ${clientY}px;
    `;

    const hoverStyle = document.createElement("style");
    hoverStyle.textContent = `
      :where(.x-contextmenu) {
        z-index: 9999; background: #fff; border: 1px solid #ccc; border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0,0,0,.25); padding: 4px 0;
        font: 13px sans-serif; user-select: none; min-width: 90px;
        max-width: 100vw; max-height: 100vh; overflow: auto; box-sizing: border-box;
      }
      :where(.x-contextmenu-item) { padding: 6px 20px; cursor: pointer; }
      :where(.x-contextmenu .x-delete, .x-contextmenu .x-delete-point) { color: #d33; }
      :where(.x-contextmenu .x-edit:hover) { background: #eee; }
      :where(.x-contextmenu .x-delete:hover, .x-contextmenu .x-delete-point:hover) { background: #fee; }
    `;
    menu.appendChild(hoverStyle);

    // 顶点删除按钮：仅当右键命中顶点且满足最少点数条件时显示
    if (vertexIndex !== undefined && vertexIndex !== -1) {
      const minPoints =
        shape.type === "line" ? 3 : shape.type === "polygon" ? 4 : 0;
      if (minPoints > 0 && shape.controlPoints.length >= minPoints) {
        const delPointBtn = document.createElement("div");
        delPointBtn.textContent = "删除该点";
        delPointBtn.className = "x-contextmenu-item x-delete-point";
        delPointBtn.addEventListener("click", () => {
          this.hideContextMenu();
          this._removeVertex(shape, vertexIndex);
        });
        menu.appendChild(delPointBtn);
      }
    }

    // 第一个按钮：编辑中 → 停止编辑；空闲 → 开始编辑（仅在启用编辑时显示）
    if (this.enableEdit) {
      const firstBtn = document.createElement("div");
      firstBtn.textContent = isEditing ? "停止编辑" : "开始编辑";
      firstBtn.className = "x-contextmenu-item x-edit";
      firstBtn.addEventListener("click", () => {
        this.hideContextMenu();
        if (isEditing) {
          this.stopEditing();
        } else {
          this.startEditing(shape);
        }
      });
      menu.appendChild(firstBtn);
    }
    // 删除按钮：删除该实体（删除不属于编辑，始终可用）
    const delBtn = document.createElement("div");
    delBtn.textContent = "删除";
    delBtn.className = "x-contextmenu-item x-delete";
    delBtn.addEventListener("click", () => {
      this.hideContextMenu();
      this.removeGraphic(shape);
    });

    menu.appendChild(delBtn);
    document.body.appendChild(menu);
    this.contextMenu = menu;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(clientX, globalThis.innerWidth - bounds.width))}px`;
    menu.style.top = `${Math.max(0, Math.min(clientY, globalThis.innerHeight - bounds.height))}px`;
    // 延迟监听必须能随菜单一起取消。
    this._menuTimer = setTimeout(() => {
      this._menuTimer = null;
      if (this._destroyed || this.contextMenu !== menu) return;
      document.addEventListener("click", this.closeContextMenuHandler, {
        once: true,
      });
    }, 0);
  }

  /**
   * 隐藏右键菜单
   */
  hideContextMenu() {
    clearTimeout(this._menuTimer);
    this._menuTimer = null;
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
    document.removeEventListener("click", this.closeContextMenuHandler);
  }

  /**
   * 删除指定顶点并重绘形状
   * @param {object} shape - 实体数据
   * @param {number} index - 顶点索引
   */
  _removeVertex(shape, index) {
    const minPoints =
      shape.type === "line" ? 2 : shape.type === "polygon" ? 3 : 0;
    if (
      !minPoints ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= shape.controlPoints.length ||
      shape.controlPoints.length <= minPoints
    )
      return;
    const candidate = shape.controlPoints.filter((_, i) => i !== index);
    if (!this._isValidShape({ ...shape, controlPoints: candidate })) return;
    // 移除顶点数据
    shape.controlPoints.splice(index, 1);
    // 移除顶点实体
    const entity = shape.controlPointEntities.splice(index, 1)[0];
    if (entity) {
      this._ownedEntities.remove(entity);
    }
    // 线 / 多边形：主实体通过 CallbackProperty 引用 shape.controlPoints，自动重绘
    // 更新中心点位置
    this._updateCenterEntity(shape);
    // 重建中间点
    this._createMidpoints(shape);
    // 触发编辑事件，通知外部数据已变更
    const result = this._buildGraphicResult(shape);
    this.viewer.scene.requestRender?.();
    this.emit("editMovePoint", result);
    this.emit("editRemovePoint", result);
  }

  /**
   * 删除一个实体（线 / 点 / 面通用）；删除后会触发 removeGraphic 事件
   * @param {object|string} shape - 实体数据或实体 ID；未找到 ID 时不执行删除
   */
  removeGraphic(shape) {
    if (typeof shape === "string") {
      shape = this.shapes.find((item) => item.mainEntity.id === shape);
    }
    if (!shape || !this.shapes.includes(shape) || shape._removing) return;
    shape._removing = true;
    const result = this._buildGraphicResult(shape);

    // 如果删除的是正在编辑的实体，先退出编辑
    if (this.editingShape === shape) {
      this.stopEditing();
    }
    if (!this.shapes.includes(shape)) return;
    this._ownedEntities.remove(shape.mainEntity);
    this._ownedEntities.remove(shape.previewEntity);
    // 移除中心点实体
    if (shape.translationHandleEntity) {
      this._ownedEntities.remove(shape.translationHandleEntity);
    }
    // 移除中间点实体
    this._clearMidpoints(shape);
    shape.controlPointEntities.forEach((item) => {
      this._ownedEntities.remove(item);
    });
    const index = this.shapes.indexOf(shape);
    if (index !== -1) {
      this.shapes.splice(index, 1);
    }
    // 删除完成：触发 removeGraphic，返回被删除实体的最终信息
    this.viewer.scene.requestRender?.();
    this.emit("removeGraphic", result);
  }

  // ======================= 编辑 =======================

  /**
   * 激活编辑：显示该实体的可拖拽点，支持拖动点位修改；开始时会触发 editStart 事件
   * 未启用编辑（enableEdit=false）时直接忽略，作为覆盖所有调用入口的最后防线
   * @param {object} shape - 实体数据
   */
  startEditing(shape) {
    this._assertAlive();
    if (
      !this.enableEdit ||
      !this.shapes.includes(shape) ||
      shape._removing ||
      this.editingShape === shape
    )
      return;
    const revision = ++this._revision;
    this.stopDraw();
    this.stopEditing();
    if (
      this._destroyed ||
      revision !== this._revision ||
      !this.shapes.includes(shape)
    )
      return;
    this.hideContextMenu();
    this._hideTooltip();
    this._cursorBefore = document.body.style.cursor;
    this.editingShape = shape;
    this._setDynamic(shape, true);
    this._createEditHandles(shape);
    // 显示点实体，并切换到编辑样式（大号、实色、白边），与画线时的点区分
    shape.controlPointEntities.forEach((item) => {
      item.show = true;
      item.point.pixelSize = shape.style.pointSize;
      item.point.color = Cesium.Color.fromCssColorString(shape.style.color);
      item.point.outlineColor = Cesium.Color.WHITE;
      item.point.outlineWidth = 2;
    });
    // 显示中心点实体（用于整体拖拽平移）
    if (shape.translationHandleEntity) {
      this._updateCenterEntity(shape); // 重新计算中心点位置（顶点可能被上次编辑移动过）
      shape.translationHandleEntity.show = true;
    }
    // 创建中间点（仅线 / 多边形，拖拽可增加顶点）
    this._createMidpoints(shape);
    this.interactionHandler = this._createInteractionHandler();
    let dragging = false; // 是否正在拖拽点，拖拽结束后忽略随后触发的 click
    // 圆和椭圆的中心控制点与平移手柄重合，两种拾取结果均表示整体平移。
    const isTranslationHandle = (entity) =>
      entity === shape.translationHandleEntity ||
      ((shape.type === "circle" || shape.type === "ellipse") &&
        entity === shape.controlPointEntities[0]);

    // 编辑状态下的悬浮检测：中心点提示“拖拽平移”，中间点提示“拖拽增加点”
    const setupHoverHandler = () => {
      this.interactionHandler.setInputAction((e) => {
        const feature = this.viewer.scene.pick(e.endPosition);
        if (!Cesium.defined(feature)) {
          this._hideTooltip();
          document.body.style.cursor = "default";
          return;
        }
        const lonlat = this.pickLonLat(e.endPosition);
        if (isTranslationHandle(feature.id)) {
          // 悬浮到中心点：提示拖拽平移
          if (lonlat) {
            this._showTooltip(
              Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
              "拖拽平移",
            );
          }
          document.body.style.cursor = "crosshair";
        } else if (
          shape.midpointEntities &&
          shape.midpointEntities.includes(feature.id)
        ) {
          // 悬浮到中间点：提示拖拽增加点
          if (lonlat) {
            this._showTooltip(
              Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
              "拖拽增加点",
            );
          }
          document.body.style.cursor = "crosshair";
        } else {
          this._hideTooltip();
          document.body.style.cursor = "default";
        }
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    };
    setupHoverHandler();

    // 左键按下：命中顶点则顶点拖拽；命中中间点则插入新顶点并拖拽；命中中心点则整体平移
    this.interactionHandler.setInputAction((e) => {
      const feature = this.viewer.scene.pick(e.position);
      dragging = false;
      if (!Cesium.defined(feature)) return;

      // 检测是否命中中间点（拖拽增加顶点）
      if (shape.midpointEntities) {
        const midIndex = shape.midpointEntities.findIndex(
          (item) => item === feature.id,
        );
        if (midIndex !== -1) {
          // 拖拽中间点：在该位置插入新顶点，然后转为顶点拖拽
          dragging = true;
          this._hideTooltip();
          document.body.style.cursor = "crosshair";
          this.lockCamera();
          // 插入新顶点（在 midIndex 和 midIndex+1 之间）
          const insertAt = midIndex + 1;
          const midLonlat =
            this.pickLonLat(e.position) ||
            this._getInsertionHandlePosition(shape, midIndex);
          const candidate = clonePoints(shape.controlPoints);
          candidate.splice(insertAt, 0, midLonlat);
          if (!this._isValidShape({ ...shape, controlPoints: candidate })) {
            this.unlockCamera();
            dragging = false;
            return;
          }
          shape.controlPoints.splice(insertAt, 0, midLonlat);
          // 创建新顶点实体（编辑样式）
          const newEntity = this.createPointEntity(midLonlat, {
            size: shape.style.pointSize,
            color: shape.style.color,
            outline: true,
            clampToGround: shape.style.clampToGround,
          });
          shape.controlPointEntities.splice(insertAt, 0, newEntity);
          // 移除被拖拽的中间点实体，重建中间点
          this._createMidpoints(shape);
          // 转为顶点拖拽逻辑
          const newIndex = insertAt;
          this.interactionHandler.setInputAction((e) => {
            const lonlat = this.pickLonLat(e.endPosition);
            if (!lonlat) return;
            this._moveControlPoint(shape, newIndex, lonlat);
          }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
          this._updateCenterEntity(shape);
          this.emit("editAddPoint", this._buildGraphicResult(shape));
          return;
        }
      }

      const index = shape.controlPointEntities.findIndex(
        (item) => item === feature.id,
      );
      if (index !== -1 && !isTranslationHandle(feature.id)) {
        // 顶点拖拽：更新单个顶点
        dragging = true;
        this._hideTooltip();
        document.body.style.cursor = "crosshair";
        this.lockCamera();
        this.interactionHandler.setInputAction((e) => {
          const lonlat = this.pickLonLat(e.endPosition);
          if (!lonlat) return;
          this._moveControlPoint(shape, index, lonlat);
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
        return;
      }
      // 整体拖拽：命中中心点，整体平移
      if (isTranslationHandle(feature.id)) {
        const start = this.pickLonLat(e.position);
        if (!start) return;
        dragging = true;
        this._hideTooltip();
        document.body.style.cursor = "crosshair";
        this.lockCamera();
        const original = shape.controlPoints.map((p) => [p[0], p[1]]);
        this.interactionHandler.setInputAction((e) => {
          const lonlat = this.pickLonLat(e.endPosition);
          if (!lonlat) return;
          const dLon = lonlat[0] - start[0];
          const dLat = lonlat[1] - start[1];
          const candidate = original.map((point) => [
            wrapLongitude(point[0] + wrapLongitude(dLon)),
            point[1] + dLat,
          ]);
          if (!this._isValidShape({ ...shape, controlPoints: candidate }))
            return;
          shape.controlPoints.splice(
            0,
            shape.controlPoints.length,
            ...candidate,
          );
          this._updateVertexEntities(shape);
          this._updateCenterEntity(shape);
          this._updateMidpoints(shape);
          this.viewer.scene.requestRender?.();
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    // 左键抬起：恢复相机操作，编辑完点后触发 editMovePoint 事件
    const finishDrag = () => {
      if (this.editingShape !== shape || !this.interactionHandler) return;
      const wasDragging = Boolean(this._cameraState);
      this.unlockCamera();
      document.body.style.cursor = this._cursorBefore ?? "";
      setupHoverHandler();
      if (wasDragging)
        this.emit("editMovePoint", this._buildGraphicResult(shape));
    };
    this.interactionHandler.setInputAction(
      finishDrag,
      Cesium.ScreenSpaceEventType.LEFT_UP,
    );
    const canvas = this.viewer.scene.canvas;
    globalThis.addEventListener?.("blur", finishDrag);
    globalThis.addEventListener?.("pointerup", finishDrag);
    canvas.addEventListener?.("mouseleave", finishDrag);
    this._dragCleanup = () => {
      globalThis.removeEventListener?.("blur", finishDrag);
      globalThis.removeEventListener?.("pointerup", finishDrag);
      canvas.removeEventListener?.("mouseleave", finishDrag);
    };

    // 左键点击：点击空白退出编辑，点击其他实体切换到该实体编辑
    this.interactionHandler.setInputAction((e) => {
      // 刚拖拽完点，忽略随后触发的 click，避免误退出 / 误切换
      if (dragging) {
        dragging = false;
        return;
      }
      const feature = this.viewer.scene.pick(e.position);
      // 点击空白处（未命中任何实体）→ 退出当前实体的编辑模式
      if (!Cesium.defined(feature)) {
        this.stopEditing();
        return;
      }
      const hitShape = this.findShapeByFeature(feature);
      if (!hitShape) {
        // 命中非本工具实体 → 视为点击空白，退出编辑
        this.stopEditing();
        return;
      }
      if (hitShape !== shape) {
        // 点到了另外的实体 → 进入该实体的编辑模式
        this.startEditing(hitShape);
      }
      // 命中当前实体自身 → 保持编辑，不做任何事
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // 右键：命中顶点时菜单顶部追加“删除该点”；命中其他位置显示常规菜单
    this.interactionHandler.setInputAction((e) => {
      const feature = this.viewer.scene.pick(e.position);
      if (!Cesium.defined(feature)) return;
      // 检测是否右键了当前编辑形状的顶点
      const vertexIndex = shape.controlPointEntities.findIndex(
        (item) => item === feature.id,
      );
      const hitShape = this.findShapeByFeature(feature);
      if (hitShape) {
        // 传入 vertexIndex（命中顶点时 >= 0，否则 -1），showContextMenu 内部判断是否显示“删除该点”
        this.showContextMenu(e.position.x, e.position.y, hitShape, {
          vertexIndex,
        });
      }
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    this.viewer.scene.requestRender?.();
    this.emit("editStart", this._buildGraphicResult(shape));
  }

  /**
   * 退出编辑：隐藏点实体，恢复空闲状态，触发 editStop 事件
   */
  stopEditing() {
    const shape = this.editingShape;
    if (!shape) return;
    const result = this._buildGraphicResult(shape);
    this.editingShape = null;
    this._releaseEditHandles(shape);
    this._setDynamic(shape, false);
    this.hideContextMenu();
    this._destroyInteractionHandler();
    this.emit("editStop", result);
  }

  // ======================= 清理 =======================

  /**
   * 清除正在绘制的对象，重新开始绘制（不退出绘制状态）
   * 实体通过 CallbackProperty 引用 points / previewPosition，清空数据后自动消失，重新加点即恢复
   * 若无进行中绘制则无操作
   */
  clearDrawing() {
    if (!this.drawingShape) {
      console.warn("当前没有进行中的绘制");
      return;
    }
    const shape = this.drawingShape;
    // 移除已添加的顶点实体
    shape.controlPointEntities.forEach((item) => {
      this._ownedEntities.remove(item);
    });
    shape.controlPointEntities = [];
    // 清空绘制数据（主实体 / 预览实体自动变为空）
    shape.controlPoints.length = 0;
    shape.previewPosition = null;
    shape.firstPointTime = null;
    if (shape.previewEntity) shape.previewEntity.show = shape.type === "line";
    if (shape.previewLineEntity) shape.previewLineEntity.show = false;
    this._hideTooltip();
    this.viewer.scene.requestRender?.();
  }

  /**
   * 停止绘制：停止当前绘制，并删除当前没有画完的实体（作废，不完成）
   * 若无进行中绘制则无操作
   */
  stopDraw() {
    const session = this._session;
    this._session = null;
    session?.reject?.(abortError());
    if (!this.drawingShape) return;
    // 删除当前未完成的实体（主实体 / 预览实体 / 顶点实体）
    const shape = this.drawingShape;
    this._ownedEntities.remove(shape.mainEntity);
    this._ownedEntities.remove(shape.previewEntity);
    this._ownedEntities.remove(shape.previewLineEntity);
    shape.controlPointEntities.forEach((item) => {
      this._ownedEntities.remove(item);
    });
    // 停止绘制状态
    this.drawingShape = null;
    this._destroyInteractionHandler();
  }

  /**
   * 清除：清空所有实体和绘制 / 编辑状态
   */
  clear() {
    if (this._clearing) return;
    this._clearing = true;
    ++this._revision;
    this.stopDraw();
    // 保存已完成图形的坐标快照，清理完成后逐个通知外部
    const results = this.shapes.map((shape) => {
      const result = this._buildGraphicResult(shape);
      return {
        ...result,
        positions: result.positions.map((point) => [...point]),
      };
    });
    this.stopEditing();
    this.unlockCamera();
    this.hideContextMenu(); // 关闭右键菜单
    if (this.idleHandler) {
      this.idleHandler.destroy();
      this.idleHandler = null;
    }
    this.drawingShape = null;
    this.shapes = [];
    this._ownedEntities.removeAll();
    this._clearing = false;
    this.viewer.scene.requestRender?.();
    results.forEach((result) => {
      this.emit("removeGraphic", result);
    });
  }

  /**
   * 内部释放当前交互监听并恢复相机及光标，不销毁工具实例
   */
  _destroyInteractionHandler() {
    this._hideTooltip();
    this.unlockCamera();
    this._dragCleanup?.();
    this._dragCleanup = null;
    this.interactionHandler?.destroy();
    this.interactionHandler = null;
    if (this._cursorBefore !== undefined) {
      document.body.style.cursor = this._cursorBefore;
      this._cursorBefore = undefined;
    }
    this.viewer.scene.requestRender?.();
  }

  /** 完整销毁实例；保留外部图层，重复调用无副作用。 */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.clear();
    this._events.clear();
    if (this._ownsDataSource) this.viewer.dataSources.remove(this.dataSource);
    const owner = viewerOwners.get(this.viewer);
    if (owner && --owner.count === 0) {
      const input = this.viewer.cesiumWidget.screenSpaceEventHandler;
      if (
        owner.action &&
        !input.isDestroyed?.() &&
        !input.getInputAction?.(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
      ) {
        input.setInputAction(
          owner.action,
          Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
        );
      }
      viewerOwners.delete(this.viewer);
    }
  }

  _assertAlive() {
    if (this._destroyed) throw new Error("绘制工具已销毁");
    if (this._clearing || this._loadingGraphics)
      throw new Error("绘制工具正在清理或加载");
  }

  get enableEdit() {
    return this._enableEdit;
  }
  set enableEdit(value) {
    this._enableEdit = Boolean(value);
    if (!this._enableEdit && this.editingShape) this.stopEditing();
  }

  get editing() {
    return Boolean(this.editingShape);
  }

  // ======================= 标签 =======================

  /**
   * 添加标签
   * @param {Cesium.Cartesian3} movePosition - 标签位置
   * @param {string} text - 标签文本
   */
  _showTooltip(movePosition, text) {
    if (!this.label) {
      this.label = this._ownedEntities.add({
        label: {
          text: "",
          showBackground: true,
          font: "14px sans-serif",
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(10, 10),
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    this.label.position = movePosition;
    this.label.label.text = text;
    this.viewer.scene.requestRender?.();
  }

  /**
   * 移除标签
   */
  _hideTooltip() {
    this.label && this._ownedEntities.remove(this.label);
    this.label = null;
    this.viewer.scene.requestRender?.();
  }
}
