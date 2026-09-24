/**
 * 画多边形模块（js/modules/drawPolygon.js）
 * 多顶点闭合面：左键点击加点 → 鼠标移动预览虚线 → 双击结束闭合。
 * 与 drawRect（对角点模型）分离：多边形直接以顶点数组为数据，编辑可独立拖拽每个顶点。
 * 通过 ctx（Draw 实例）调用公共工具方法。
 *
 * 避坑说明（与既有模块一致）：
 * - 交互切换和会话取消由核心类统一管理
 * - 预览虚线 hierarchy 用自定义回调（previewPosition），不误用 points 数组
 * - 面实体 hierarchy 用 CallbackProperty 引用 points，编辑拖拽自动更新
 * - 双击画第一个点时不结束绘制
 *
 * @param {object} ctx - Draw 实例（this）
 * @param {object} options - 画多边形参数
 * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
 * @param {Array} [options.data] - 初始顶点坐标（[[lon, lat], ...]），空数组表示交互绘制
 * @param {object} [options.style] - 样式（lineWidth / color / pointSize / clampToGround）
 */
export default function drawPolygon(ctx, { id, data = [], style = {} }) {
  const shape = ctx._createDrawingShape("polygon", { id, style, data });

  // 主实体：面（hierarchy 引用 points，自动闭合，编辑拖拽自动更新）
  createPolygonEntity(ctx, shape);

  // 加点：顶点实体（画线样式：小号、无白边）
  const addPoint = (lonlat) => {
    const entity = ctx._createControlPoint(shape, lonlat);
    shape.controlPointEntities.push(entity);
    return entity;
  };

  // 完成绘制
  const finishDraw = () => {
    // 一个点都还没画时，双击不退出绘制（忽略本次双击，继续画）
    if (shape.controlPoints.length === 0) return;
    // 双击画第一个点：第一个点刚画（500ms 内）就触发双击，
    // 回退双击多加的点，只保留第一个点，不退出绘制
    if (
      shape.firstPointTime &&
      Date.now() - shape.firstPointTime < 500 &&
      shape.controlPoints.length <= 2
    ) {
      while (shape.controlPoints.length > 1) {
        ctx._ownedEntities.remove(shape.controlPointEntities.pop());
        shape.controlPoints.pop();
        ctx.emit("drawRemovePoint", ctx._buildGraphicResult(shape));
        if (ctx.drawingShape !== shape) return;
      }
      shape.firstPointTime = null;
      return;
    }
    shape.firstPointTime = null;
    // 移除预览虚线和预览面
    ctx._ownedEntities.remove(shape.previewLineEntity);
    shape.previewLineEntity = null;
    ctx._ownedEntities.remove(shape.previewEntity);
    shape.previewEntity = null;
    if (shape.controlPoints.length < 3) {
      // 顶点不足，整个面作废
      ctx._ownedEntities.remove(shape.mainEntity);
      shape.controlPointEntities.forEach((item) => {
        ctx._ownedEntities.remove(item);
      });
      console.warn("多边形至少需要三个点");
      ctx.stopDraw();
      return;
    }
    // 显示正式面（绘制中隐藏，完成时显示）
    shape.mainEntity.show = true;
    ctx.completeShape(shape);
  };

  // 预置坐标数据的场景：直接画好并入库
  if (shape.controlPoints.length >= 3) {
    shape.controlPoints.forEach(addPoint);
    ctx._emitDrawStart(shape);
    if (ctx.drawingShape !== shape) return;
    ctx.completeShape(shape);
    return;
  }

  // 交互绘制中隐藏正式面，只显示预览（避免两个半透明面叠加颜色加深）
  shape.mainEntity.show = false;

  // 预览虚线：最后一点 → 鼠标位置（顶点不足 2 个时只有虚线，可视效果更好）
  // 避坑：positions 用自定义回调，不误用 points 数组
  shape.previewLineEntity = ctx.createPolylineEntity(
    shape.controlPoints,
    shape.style,
    {
      dash: true,
      positions: () => {
        if (shape.controlPoints.length === 0 || !shape.previewPosition)
          return [];
        const last = shape.controlPoints[shape.controlPoints.length - 1];
        return [
          Cesium.Cartesian3.fromDegrees(last[0], last[1]),
          Cesium.Cartesian3.fromDegrees(
            shape.previewPosition[0],
            shape.previewPosition[1],
          ),
        ];
      },
    },
  );
  shape.previewLineEntity.show = false;

  // 预览面：跟随鼠标（已画顶点 + 鼠标位置临时闭合），顶点 ≥ 2 时显示面
  shape.previewEntity = ctx.createPolygonEntity([], shape.style, {
    positions: () => {
      if (shape.controlPoints.length < 2) return []; // 顶点不足，面退化为虚线预览
      return [
        ...shape.controlPoints,
        shape.previewPosition ||
          shape.controlPoints[shape.controlPoints.length - 1],
      ];
    },
  });
  shape.previewEntity.show = false;

  ctx.interactionHandler = ctx._createInteractionHandler();
  // 监听鼠标移动：更新临时预览 + 显示坐标标签
  ctx.interactionHandler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.endPosition);
    if (!lonlat) {
      ctx._hideTooltip();
      return; // 如果没有点击到地面，返回
    }
    ctx._showTooltip(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      `单击加点，右击删除，双击结束\n经度：${lonlat[0]}°\n纬度：${lonlat[1]}°`,
    );
    if (shape.controlPoints.length > 0) {
      // 临时闭合点（经纬度），虚线 / 预览面回调都会用到
      shape.previewPosition = lonlat;
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // 监听左键点击：记录顶点
  ctx.interactionHandler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.position);
    if (!lonlat || !ctx._canAddPoint(shape, lonlat)) return;
    if (shape.controlPoints.length > 0) {
      const last = shape.controlPoints[shape.controlPoints.length - 1];
      if (last[0] === lonlat[0] && last[1] === lonlat[1]) return;
    }
    // 记录第一个点的点击时间，用于识别"双击画第一个点"场景
    if (shape.controlPoints.length === 0) {
      shape.firstPointTime = Date.now();
    }
    shape.controlPoints.push(lonlat);
    addPoint(lonlat);
    // 预览：只有 1 个点时显示虚线（连接第一点到鼠标）；≥ 2 个点只显示预览面
    shape.previewLineEntity.show = shape.controlPoints.length < 2;
    shape.previewEntity.show = shape.controlPoints.length >= 2;
    ctx.emit("drawAddPoint", ctx._buildGraphicResult(shape));
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 监听右键点击：删除最后一个顶点，删除后预览立即重绘
  ctx.interactionHandler.setInputAction((e) => {
    if (shape.controlPoints.length === 0) return; // 没有点可删
    ctx._ownedEntities.remove(shape.controlPointEntities.pop());
    shape.controlPoints.pop();
    if (shape.controlPoints.length > 0) {
      const lonlat = ctx.pickLonLat(e.position);
      if (lonlat) {
        shape.previewPosition = lonlat;
      }
      // 删到只剩 1 个点时：面退化为虚线；≥ 2 个点只显示面
      shape.previewLineEntity.show = shape.controlPoints.length < 2;
      shape.previewEntity.show = shape.controlPoints.length >= 2;
    } else {
      // 没有点了，预览消失
      shape.previewLineEntity.show = false;
      shape.previewEntity.show = false;
      shape.previewPosition = null;
    }
    ctx.emit("drawRemovePoint", ctx._buildGraphicResult(shape));
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

  // 监听双击，结束绘制
  ctx.interactionHandler.setInputAction(() => {
    finishDraw();
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  ctx._emitDrawStart(shape);
}

export function createPolygonEntity(ctx, shape) {
  shape.mainEntity = ctx.createPolygonEntity(shape.controlPoints, shape.style, {
    id: shape.id,
    positions: () => shape.controlPoints,
  });
}
