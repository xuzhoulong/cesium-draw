// 引入绘制模块（画线逻辑独立存放，避免本文件代码杂乱）
import drawLineModule from "./modules/drawLine.js";
import drawPointModule from "./modules/drawPoint.js";
import drawRectModule from "./modules/drawRect.js";
import drawPolygonModule from "./modules/drawPolygon.js";
import drawCircleModule from "./modules/drawCircle.js";
import drawEllipseModule from "./modules/drawEllipse.js";

export default class draw {
  /**
   * @param {object} viewer - Cesium Viewer 实例
   * @param {object} [config] - 实例配置
   * @param {boolean} [config.isAutoEditing=true] - 绘制完成后是否自动激活编辑
   * @param {object} [config.style] - 默认样式（lineWidth / color / pointSize）
   *   也可直接传旧写法：{ lineWidth, color, pointSize }
   */
  constructor(viewer, config) {
    this.viewer = viewer;
    const style = config?.style || {};
    this.config = {
      // 默认样式：style 优先，其次兼容旧写法直接字段
      lineWidth: style.lineWidth ?? config?.lineWidth ?? 2,
      color: style.color ?? config?.color ?? "#00ffff",
      pointSize: style.pointSize ?? config?.pointSize ?? 10,
    };
    // 绘制完成后是否自动激活编辑（默认 true，保持原有行为）
    this.isAutoEditing = config?.isAutoEditing ?? true;
    this.handler = null; // 当前绘制 / 编辑的事件处理器
    this.idleHandler = null; // 空闲状态下的"点击激活编辑"处理器
    this.shapes = []; // 所有已绘制完成的实体数据（线 / 点 / 面）
    this.activeShape = null; // 正在绘制的实体数据
    this.editShape = null; // 正在编辑的实体数据
    this.editing = false; // 是否处于编辑状态
    this.label = null; // 经纬度 / 悬停提示标签
    this.contextMenu = null; // 右键菜单 DOM
    this.closeContextMenuHandler = () => this.hideContextMenu(); // 关闭右键菜单的处理器
    this._events = {}; // 事件监听器存储 { 事件名: [回调, ...] }
    this.viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
  }

  // ======================= 公共工具方法（画点、画面等后续复用） =======================

  /**
   * 屏幕坐标 → 经纬度 [lon, lat]；未命中地面返回 null
   * @param {Cesium.Cartesian2} screenPosition - 屏幕坐标
   * @returns {Array|null} [lon, lat]
   */
  pickLonLat(screenPosition) {
    const cartesian = this.viewer.scene.camera.pickEllipsoid(screenPosition);
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
    const size = options.size ?? this.config.pointSize;
    const color = options.color ?? this.config.color;
    const outline = options.outline ?? false;
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
    return this.viewer.entities.add({
      id, // 传了 id 则指定实体 id，不传由 Cesium 自动生成
      position: Cesium.Cartesian3.fromDegrees(position[0], position[1]),
      point,
    });
  }

  /**
   * 创建线实体（实线 / 虚线）
   * positions 使用 CallbackProperty 引用 points 数组，直接修改数组即可自动更新；
   * 也可通过 options.positions 传入自定义回调（如临时预览虚线返回 tempPoint）
   * @param {Array} points - 坐标点数组
   * @param {object} [style] - { lineWidth, color }
   * @param {object} [options] - { dash: 是否虚线, positions: 自定义 positions 回调, id: 自定义实体 id }
   * @returns {Cesium.Entity}
   */
  createPolylineEntity(points, style = {}, options = {}) {
    const lineWidth = style.lineWidth ?? this.config.lineWidth;
    const color = style.color ?? this.config.color;
    const { dash = false, positions, id } = options;
    const polyline = {
      positions: new Cesium.CallbackProperty(
        typeof positions === "function"
          ? positions
          : () => this.positionsToCartesian(points),
        false,
      ),
      width: lineWidth,
      zIndex: 1,
    };
    if (dash) {
      polyline.material = new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString(color), // 虚线实色，不透明
        dashLength: 20,
      });
    } else {
      polyline.material = Cesium.Color.fromCssColorString(color);
      polyline.clampToGround = true;
    }
    // 传了 id 则指定实体 id，不传由 Cesium 自动生成
    return this.viewer.entities.add({ id, polyline });
  }

  /**
   * 创建面实体（多边形 / 矩形）
   * hierarchy 使用 CallbackProperty 引用 points 数组，直接修改数组即可自动更新；
   * 也可通过 options.positions 传入自定义回调（如预览矩形用鼠标位置实时计算）
   * @param {Array} points - 坐标点数组 [[lon, lat], ...]
   * @param {object} [style] - { color }
   * @param {object} [options] - { id: 自定义实体 id, positions: 自定义 hierarchy 回调 }
   * @returns {Cesium.Entity}
   */
  createPolygonEntity(points, style = {}, options = {}) {
    const color = style.color ?? this.config.color;
    const { id, positions } = options;
    return this.viewer.entities.add({
      id, // 传了 id 则指定实体 id，不传由 Cesium 自动生成
      polygon: {
        hierarchy: new Cesium.CallbackProperty(() => {
          const p = typeof positions === "function" ? positions() : points;
          return new Cesium.PolygonHierarchy(this.positionsToCartesian(p));
        }, false),
        material: Cesium.Color.fromCssColorString(color).withAlpha(0.5), // 半透明填充
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(color),
        outlineWidth: 2,
        height: 0, // 显式设置高度，禁用地形夹取，启用轮廓线（否则贴地不支持 outline）
        // 注意：有 height 时 Cesium 不支持 zIndex，故不设置
      },
    });
  }

  /**
   * 创建椭圆 / 圆实体
   * position / semiMajorAxis / semiMinorAxis / rotation 均支持函数（自动转 CallbackProperty），
   * 实现"绘制预览 / 完成固定 / 编辑拖拽"全程自动更新
   * @param {Array} center - 中心点 [lon, lat]（仅作默认值）
   * @param {object} [style] - { color }
   * @param {object} [options] - { id, position, semiMajorAxis, semiMinorAxis, rotation }
   * @returns {Cesium.Entity}
   */
  createEllipseEntity(center, style = {}, options = {}) {
    const color = style.color ?? this.config.color;
    const { id, position, semiMajorAxis, semiMinorAxis, rotation } = options;
    const toProp = (v) =>
      typeof v === "function" ? new Cesium.CallbackProperty(v, false) : v;
    return this.viewer.entities.add({
      id, // 传了 id 则指定实体 id，不传由 Cesium 自动生成
      position: toProp(position) ?? Cesium.Cartesian3.fromDegrees(center[0], center[1]),
      ellipse: {
        semiMajorAxis: toProp(semiMajorAxis),
        semiMinorAxis: toProp(semiMinorAxis),
        rotation: toProp(rotation),
        material: Cesium.Color.fromCssColorString(color).withAlpha(0.5), // 半透明填充
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(color),
        outlineWidth: 2,
        height: 0,
      },
    });
  }

  /**
   * 锁定相机操作（拖拽编辑时禁用旋转 / 平移 / 缩放）
   */
  lockCamera() {
    const c = this.viewer.scene.screenSpaceCameraController;
    c.enableRotate = false;
    c.enableTranslate = false;
    c.enableZoom = false;
  }

  /**
   * 恢复相机操作
   */
  unlockCamera() {
    const c = this.viewer.scene.screenSpaceCameraController;
    c.enableRotate = true;
    c.enableTranslate = true;
    c.enableZoom = true;
  }

  /**
   * 根据拾取的实体查找所属 shape
   * @param {object} feature - scene.pick 的结果
   * @returns {object|null}
   */
  findShapeByFeature(feature) {
    if (!Cesium.defined(feature)) return null;
    return this.shapes.find(
      (s) => s.mainEntity === feature.id || s.pointsEntity.includes(feature.id),
    );
  }

  /**
   * 更新形状的顶点实体位置（整体拖拽后同步显示）
   * 矩形特殊：4 个角点由对角点推导；其他形状顶点与 points 一一对应
   * @param {object} shape - 实体数据
   */
  _updateVertexEntities(shape) {
    if (shape.type === "rect" && shape.points.length === 2) {
      // 矩形：由对角点推导 4 个角点
      const [a, b] = shape.points;
      const corners = [
        [a[0], a[1]],
        [b[0], a[1]],
        [b[0], b[1]],
        [a[0], b[1]],
      ];
      shape.pointsEntity.forEach((entity, i) => {
        entity.position.setValue(
          Cesium.Cartesian3.fromDegrees(corners[i][0], corners[i][1]),
        );
      });
      return;
    }
    // 其他形状：顶点实体与 points 一一对应
    shape.pointsEntity.forEach((entity, i) => {
      const p = shape.points[i];
      if (p) {
        entity.position.setValue(
          Cesium.Cartesian3.fromDegrees(p[0], p[1]),
        );
      }
    });
  }

  // ======================= 事件系统 =======================

  /**
   * 注册事件监听
   * 用法：draw.on("editMovePoint", (data) => { ... })，data 为 { id, positions, type }
   * @param {string} eventName - 事件名（如 "editMovePoint" 编辑完点 / "editStop" 结束编辑）
   * @param {Function} callback - 回调，收到事件数据
   * @returns {this} 支持链式调用
   */
  on(eventName, callback) {
    if (typeof callback !== "function") return this;
    (this._events[eventName] = this._events[eventName] || []).push(callback);
    return this;
  }

  /**
   * 移除事件监听
   * @param {string} eventName - 事件名
   * @param {Function} [callback] - 要移除的回调，不传则移除该事件所有回调
   * @returns {this} 支持链式调用
   */
  off(eventName, callback) {
    const list = this._events[eventName];
    if (!list) return this;
    if (!callback) {
      delete this._events[eventName];
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
    const list = this._events[eventName];
    if (!list) return;
    [...list].forEach((cb) => cb(data));
  }

  /**
   * 构造实体结果对象 { id, positions, type }（内部使用，回调 / 事件共用）
   * positions 为 shape.points 引用，实时反映最新坐标；
   * 矩形内部存对角点，对外返回推导出的 4 个角点
   * @param {object} shape - 实体数据
   * @returns {object} { id, positions, type }
   */
  _shapeResult(shape) {
    let positions = shape.points;
    if (shape.type === "rect" && shape.points.length === 2) {
      const [a, b] = shape.points;
      positions = [
        [a[0], a[1]],
        [b[0], a[1]],
        [b[0], b[1]],
        [a[0], b[1]],
      ];
    }
    return {
      id: shape.mainEntity.id, // 实体 id
      positions, // 最新坐标
      type: shape.type, // 绘制类型
    };
  }

  // ======================= 绘制入口 =======================

  /**
   * 开始绘制（统一入口）
   * 支持两种调用方式：
   * 1. 回调：draw.startDraw({ id, type, style, success: cb })
   * 2. 异步：draw.startDraw({ id, type, style }).then(cb)
   * @param {object} options - 绘制配置
   * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
   * @param {string} options.type - 绘制类型："line" 画线（后续可扩展 "point" / "polygon"）
   * @param {object} [options.style] - 样式配置（lineWidth / color / pointSize）
   * @param {Function} [options.success] - 绘制完成后的回调（可选，与 Promise 二选一）
   * @returns {Promise|undefined} 未传 success 时返回 Promise，绘制完成 resolve 对象 { id, positions, type }
   */
  startDraw(options = {}) {
    const { type, style = {}, success, id } = options;
    if (type === "line") {
      if (typeof success === "function") {
        // 回调方式（原方法保留）
        this.drawLine({ data: [], style, success, id });
        return;
      }
      // 异步 Promise 方式
      return new Promise((resolve) => {
        this.drawLine({ data: [], style, success: resolve, id });
      });
    }
    if (type === "point") {
      if (typeof success === "function") {
        this.drawPoint({ style, success, id });
        return;
      }
      return new Promise((resolve) => {
        this.drawPoint({ style, success: resolve, id });
      });
    }
    if (type === "rect") {
      if (typeof success === "function") {
        this.drawRect({ style, success, id });
        return;
      }
      return new Promise((resolve) => {
        this.drawRect({ style, success: resolve, id });
      });
    }
    if (type === "polygon") {
      if (typeof success === "function") {
        this.drawPolygon({ style, success, id });
        return;
      }
      return new Promise((resolve) => {
        this.drawPolygon({ style, success: resolve, id });
      });
    }
    if (type === "circle") {
      if (typeof success === "function") {
        this.drawCircle({ style, success, id });
        return;
      }
      return new Promise((resolve) => {
        this.drawCircle({ style, success: resolve, id });
      });
    }
    if (type === "ellipse") {
      if (typeof success === "function") {
        this.drawEllipse({ style, success, id });
        return;
      }
      return new Promise((resolve) => {
        this.drawEllipse({ style, success: resolve, id });
      });
    }
    console.warn(`startDraw: 暂不支持的绘制类型 "${type}"`);
  }

  // ======================= 画线 =======================

  /**
   * 画线：支持绘制多条线，每次调用都是一条独立的新线
   * 具体交互逻辑见 js/modules/drawLine.js
   * @param {object} options - 画线参数
   * @param {Array} [options.data] - 初始坐标点（[[lon, lat], ...]），空数组表示交互绘制
   * @param {object} [options.style] - 样式（lineWidth / color / pointSize）
   * @param {Function} [options.success] - 绘制完成回调，返回该线坐标点数组
   */
  drawLine(options) {
    drawLineModule(this, options);
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
    drawPointModule(this, options);
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
    drawRectModule(this, options);
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
    drawPolygonModule(this, options);
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
    drawCircleModule(this, options);
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
    drawEllipseModule(this, options);
  }

  /**
   * 通用完成流程：隐藏点、入库、触发回调、根据配置进入编辑（画点 / 画面等后续复用）
   * 绘制完成回调返回：{ id, positions, type }
   * @param {object} shape - 实体数据
   */
  completeShape(shape) {
    shape.pointsEntity.forEach((item) => {
      // 跳过主实体：点的主实体就是点本身需要一直显示；线的主实体不在 pointsEntity 中，不受影响
      if (item !== shape.mainEntity) {
        item.show = false;
      }
    });
    this.shapes.push(shape);
    // 触发完成回调：返回 { id, positions, type }
    shape.success && shape.success(this._shapeResult(shape));
    this.setupIdleHandler(); // 开启空闲点击激活
    this.activeShape = null;
    this.destroy(); // 销毁绘制 handler
    // 根据配置决定是否自动激活编辑（isAutoEditing，默认 true）
    if (this.isAutoEditing) {
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
    if (this.idleHandler) return;
    this.idleHandler = new Cesium.ScreenSpaceEventHandler(
      this.viewer.scene.canvas,
    );
    // 鼠标移动：悬停检测，命中实体时显示编辑提示
    this.idleHandler.setInputAction((e) => {
      // 绘制中 / 编辑中不处理悬停（避免干扰绘制经纬度标签）
      if (this.activeShape || this.editing) return;
      const shape = this.findShapeByFeature(
        this.viewer.scene.pick(e.endPosition),
      );
      if (shape) {
        // 命中实体：在鼠标位置显示编辑提示
        const lonlat = this.pickLonLat(e.endPosition);
        if (lonlat) {
          this.addLabel(
            Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
            "左键点击进行编辑，右键菜单",
          );
        }
      } else {
        this.removeLabel();
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    // 左键点击实体：激活编辑
    this.idleHandler.setInputAction((e) => {
      if (this.activeShape || this.editing) return;
      const shape = this.findShapeByFeature(this.viewer.scene.pick(e.position));
      if (shape) {
        this.startEditing(shape);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    // 右键实体：弹出右键菜单
    this.idleHandler.setInputAction((e) => {
      if (this.activeShape || this.editing) return;
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
   */
  showContextMenu(x, y, shape) {
    this.hideContextMenu();
    // 当前是否正在编辑该实体：是则显示"停止编辑"，否则显示"开始编辑"
    const isEditing = this.editShape === shape;
    const menu = document.createElement("div");
    menu.style.cssText = `
      position: fixed; left: ${x}px; top: ${y}px; z-index: 9999;
      background: #fff; border: 1px solid #ccc; border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,.25); padding: 4px 0;
      font: 13px sans-serif; user-select: none; min-width: 90px;
    `;
    // 第一个按钮：编辑中 → 停止编辑；空闲 → 开始编辑
    const firstBtn = document.createElement("div");
    firstBtn.textContent = isEditing ? "停止编辑" : "开始编辑";
    firstBtn.style.cssText = "padding: 6px 20px; cursor: pointer;";
    firstBtn.addEventListener("mouseenter", () => {
      firstBtn.style.background = "#eee";
    });
    firstBtn.addEventListener("mouseleave", () => {
      firstBtn.style.background = "";
    });
    firstBtn.addEventListener("click", () => {
      this.hideContextMenu();
      if (isEditing) {
        this.stopEditing(); // 停止编辑
      } else {
        this.startEditing(shape); // 进入编辑（原有逻辑）
      }
    });
    // 删除按钮：删除该实体
    const delBtn = document.createElement("div");
    delBtn.textContent = "删除";
    delBtn.style.cssText = "padding: 6px 20px; cursor: pointer; color: #d33;";
    delBtn.addEventListener("mouseenter", () => {
      delBtn.style.background = "#fee";
    });
    delBtn.addEventListener("mouseleave", () => {
      delBtn.style.background = "";
    });
    delBtn.addEventListener("click", () => {
      this.hideContextMenu();
      this.removeShape(shape);
    });

    menu.appendChild(firstBtn);
    menu.appendChild(delBtn);
    document.body.appendChild(menu);
    this.contextMenu = menu;
    // 点击菜单以外的任意位置关闭菜单
    setTimeout(() => {
      document.addEventListener("click", this.closeContextMenuHandler, {
        once: true,
      });
    }, 0);
  }

  /**
   * 隐藏右键菜单
   */
  hideContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
    document.removeEventListener("click", this.closeContextMenuHandler);
  }

  /**
   * 删除一个实体（线 / 点 / 面通用）
   * @param {object} shape - 实体数据
   */
  removeShape(shape) {
    // 如果删除的是正在编辑的实体，先退出编辑
    if (this.editShape === shape) {
      this.stopEditing();
    }
    this.viewer.entities.remove(shape.mainEntity);
    this.viewer.entities.remove(shape.tempEntity);
    shape.pointsEntity.forEach((item) => {
      this.viewer.entities.remove(item);
    });
    const index = this.shapes.indexOf(shape);
    if (index !== -1) {
      this.shapes.splice(index, 1);
    }
  }

  // ======================= 编辑 =======================

  /**
   * 激活编辑：显示该实体的可拖拽点，支持拖动点位修改
   * @param {object} shape - 实体数据
   */
  startEditing(shape) {
    this.destroy(); // 结束之前可能存在的绘制 / 编辑状态
    // 切换编辑时，先隐藏上一个编辑实体的点（防止前一个实体的点残留显示）
    if (this.editShape && this.editShape !== shape) {
      this.editShape.pointsEntity.forEach((item) => {
        if (item === this.editShape.mainEntity) {
          // 点主实体：恢复普通样式（去掉编辑白边）
          item.point.outlineWidth = 0;
        } else {
          item.show = false;
        }
      });
      // 上一个实体的编辑结束：触发 editStop，返回其最新信息
      this.emit("editStop", this._shapeResult(this.editShape));
    }
    this.removeLabel(); // 清除悬停提示标签
    this.editing = true;
    this.editShape = shape;
    // 显示点实体，并切换到编辑样式（大号、实色、白边），与画线时的点区分
    shape.pointsEntity.forEach((item) => {
      item.show = true;
      item.point.pixelSize = shape.style.pointSize;
      item.point.color = Cesium.Color.fromCssColorString(shape.style.color);
      item.point.outlineColor = Cesium.Color.WHITE;
      item.point.outlineWidth = 2;
    });

    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    let dragging = false; // 是否正在拖拽点，拖拽结束后忽略随后触发的 click

    // 左键按下：命中顶点则顶点拖拽；命中主体实体则整体拖拽移动
    this.handler.setInputAction((e) => {
      const feature = this.viewer.scene.pick(e.position);
      dragging = false;
      if (!Cesium.defined(feature)) return;
      const index = shape.pointsEntity.findIndex(
        (item) => item === feature.id,
      );
      if (index !== -1) {
        // 顶点拖拽：更新单个顶点
        dragging = true;
        document.body.style.cursor = "move";
        this.lockCamera();
        this.handler.setInputAction((e) => {
          const lonlat = this.pickLonLat(e.endPosition);
          if (!lonlat) return; // 如果没有点击到地面，返回
          if (shape.updatePoint) {
            // 特殊形状（如矩形）：自定义联动更新，保持形状特征
            shape.updatePoint(index, lonlat);
          } else {
            // 通用形状：直接更新该顶点坐标
            shape.points[index] = lonlat;
          }
          // 线实体 positions 通过 CallbackProperty 引用 shape.points，自动更新
          shape.pointsEntity[index].position.setValue(
            Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
          );
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
        return;
      }
      // 整体拖拽：命中主体实体（线 / 面 / 圆 / 椭圆），整体平移
      if (feature.id === shape.mainEntity) {
        const start = this.pickLonLat(e.position);
        if (!start) return; // 没有命中地面则不拖拽
        dragging = true;
        document.body.style.cursor = "move";
        this.lockCamera();
        // 记录拖拽起点和原始坐标快照（避免累计误差）
        const original = shape.points.map((p) => [p[0], p[1]]);
        this.handler.setInputAction((e) => {
          const lonlat = this.pickLonLat(e.endPosition);
          if (!lonlat) return; // 如果没有点击到地面，返回
          const dLon = lonlat[0] - start[0];
          const dLat = lonlat[1] - start[1];
          // 所有点整体平移（主体实体通过 CallbackProperty 自动更新）
          shape.points.forEach((p, i) => {
            p[0] = original[i][0] + dLon;
            p[1] = original[i][1] + dLat;
          });
          // 同步更新顶点实体位置（矩形由对角点推导 4 角，其他形状一一对应）
          this._updateVertexEntities(shape);
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    // 左键抬起：恢复相机操作，编辑完点后触发 editMovePoint 事件
    this.handler.setInputAction(() => {
      this.unlockCamera();
      document.body.style.cursor = "default";
      this.handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      // 拖拽编辑结束（编辑完点）：触发 editMovePoint，回调返回最新数据 { id, positions, type }
      // （dragging 不重置，留给 LEFT_CLICK 抑制误操作）
      if (dragging) {
        // 编辑完点：触发 editMovePoint，返回最新信息
        this.emit("editMovePoint", this._shapeResult(shape));
      }
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    // 左键点击：点击空白退出编辑，点击其他实体切换到该实体编辑
    this.handler.setInputAction((e) => {
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

    // 右键：命中实体时弹出右键菜单（编辑 / 删除），与空闲状态行为一致
    this.handler.setInputAction((e) => {
      const feature = this.viewer.scene.pick(e.position);
      const hitShape = this.findShapeByFeature(feature);
      if (hitShape) {
        this.showContextMenu(e.position.x, e.position.y, hitShape);
      }
      // 右键空白处：不弹菜单，保持编辑
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  }

  /**
   * 退出编辑：隐藏点实体，恢复空闲状态，触发 editStop 事件
   */
  stopEditing() {
    this.removeLabel(); // 清除提示标签
    if (this.editShape) {
      this.editShape.pointsEntity.forEach((item) => {
        if (item === this.editShape.mainEntity) {
          // 点主实体：恢复普通样式（去掉编辑白边）
          item.point.outlineWidth = 0;
        } else {
          item.show = false;
        }
      });
      // 结束编辑：触发 editStop，返回当前实体最新信息
      this.emit("editStop", this._shapeResult(this.editShape));
    }
    this.editShape = null;
    this.editing = false;
    this.destroy();
  }

  // ======================= 清理 =======================

  /**
   * 清除正在绘制的对象，重新开始绘制（不退出绘制状态）
   * 实体通过 CallbackProperty 引用 points / tempPoint，清空数据后自动消失，重新加点即恢复
   * 若无进行中绘制则无操作
   */
  clearDrawing() {
    if (!this.activeShape) {
      console.warn("当前没有进行中的绘制");
      return;
    }
    const shape = this.activeShape;
    // 移除已添加的顶点实体
    shape.pointsEntity.forEach((item) => {
      this.viewer.entities.remove(item);
    });
    shape.pointsEntity = [];
    // 清空绘制数据（主实体 / 预览实体自动变为空）
    shape.points = [];
    shape.tempPoint = null;
    shape.firstPointTime = null;
    this.removeLabel(); // 清除坐标标签
  }

  /**
   * 停止绘制：停止当前绘制，并删除当前没有画完的实体（作废，不完成）
   * 若无进行中绘制则无操作
   */
  stopDraw() {
    if (!this.activeShape) {
      console.warn("当前没有进行中的绘制");
      return;
    }
    // 删除当前未完成的实体（主实体 / 预览实体 / 顶点实体）
    const shape = this.activeShape;
    this.viewer.entities.remove(shape.mainEntity);
    this.viewer.entities.remove(shape.tempEntity);
    this.viewer.entities.remove(shape.tempDashEntity);
    shape.pointsEntity.forEach((item) => {
      this.viewer.entities.remove(item);
    });
    // 停止绘制状态
    this.activeShape = null;
    this.destroy();
  }

  /**
   * 清除：清空所有实体和绘制 / 编辑状态
   */
  clear() {
    this.destroy();
    this.hideContextMenu(); // 关闭右键菜单
    if (this.idleHandler) {
      this.idleHandler.destroy();
      this.idleHandler = null;
    }
    this.shapes = [];
    this.viewer.entities.removeAll();
  }

  /**
   * 销毁当前绘制 / 编辑 handler
   */
  destroy = () => {
    this.removeLabel();
    this.handler && this.handler.destroy();
    this.handler = null;
  };

  // ======================= 标签 =======================

  /**
   * 添加标签
   * @param {Cesium.Cartesian3} movePosition - 标签位置
   * @param {string} text - 标签文本
   */
  addLabel(movePosition, text) {
    if (!this.label) {
      this.label = this.viewer.entities.add({
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
  }

  /**
   * 移除标签
   */
  removeLabel() {
    this.label && this.viewer.entities.remove(this.label);
    this.label = null;
  }
}
