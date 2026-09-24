/**
 * 画线模块（js/modules/drawLine.js）
 * 独立的画线交互逻辑，通过 ctx（Draw 实例）调用公共工具方法，
 * 避免 drawTool.js 代码杂乱；后续画点 / 画面可参照本模块拆分。
 *
 * @param {object} ctx - Draw 实例（this）
 * @param {object} options - 画线参数
 * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
 * @param {Array} [options.data] - 初始坐标点（[[lon, lat], ...]），空数组表示交互绘制
 * @param {object} [options.style] - 样式（lineWidth / color / pointSize / clampToGround）
 */
export default function drawLine(ctx, { id, data = [], style = {} }) {
  const shape = ctx._createDrawingShape("line", { id, style, data });

  // 主实体：实线（传了 id 则指定实体 id，不传由 Cesium 自动生成）

  createLineEntity(ctx, shape);

  // 加点：画线过程中的点（小号、无描边）
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
    // 移除临时虚线
    ctx._ownedEntities.remove(shape.previewEntity);
    shape.previewEntity = null;
    if (shape.controlPoints.length < 2) {
      // 点数不足，整条线作废
      ctx._ownedEntities.remove(shape.mainEntity);
      shape.controlPointEntities.forEach((item) => {
        ctx._ownedEntities.remove(item);
      });
      console.warn("请至少选择两个点");
      ctx.stopDraw();
      return;
    }
    ctx.completeShape(shape);
  };

  // 预置坐标数据的场景：直接画好并入库，画完马上进入编辑
  if (shape.controlPoints.length > 1) {
    shape.controlPoints.forEach(addPoint);
    ctx._emitDrawStart(shape);
    if (ctx.drawingShape !== shape) return;
    ctx.completeShape(shape);
    return;
  }

  // 临时虚线，跟随鼠标移动（positions 返回最后一个点到鼠标位置的 previewPosition）
  shape.previewEntity = ctx.createPolylineEntity(
    shape.controlPoints,
    shape.style,
    {
      dash: true,
      positions: () =>
        shape.controlPoints.length && shape.previewPosition
          ? ctx.positionsToCartesian([
              shape.controlPoints.at(-1),
              shape.previewPosition,
            ])
          : [],
    },
  );

  ctx.interactionHandler = ctx._createInteractionHandler();
  // 监听鼠标移动，动态更新临时虚线 + 显示经纬度标签
  ctx.interactionHandler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.endPosition);
    if (!lonlat) {
      ctx._hideTooltip();
      return; // 如果没有点击到地面，返回
    }
    ctx._showTooltip(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      `单击新增，右击删除，双击结束\n经度：${lonlat[0]}°\n纬度：${lonlat[1]}°`,
    );
    // 更新跟随鼠标的临时虚线（只要鼠标移动时）
    if (shape.controlPoints.length > 0) {
      shape.previewPosition = lonlat;
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  // 监听左键点击，记录坐标并绘制线段
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
    shape.controlPoints.push(lonlat); // 保存坐标
    addPoint(lonlat);
    ctx.emit("drawAddPoint", ctx._buildGraphicResult(shape));
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 监听右键点击：删除最后一个点，删除后虚线立即重绘
  ctx.interactionHandler.setInputAction((e) => {
    if (shape.controlPoints.length === 0) return; // 没有点可删
    ctx._ownedEntities.remove(shape.controlPointEntities.pop());
    shape.controlPoints.pop();
    if (shape.controlPoints.length > 0) {
      // 从新的最后一个点连接到当前鼠标位置
      const lonlat = ctx.pickLonLat(e.position);
      if (lonlat) {
        shape.previewPosition = lonlat;
      }
    } else {
      // 没有点了，虚线消失
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

export function createLineEntity(ctx, shape) {
  shape.mainEntity = ctx.createPolylineEntity(
    shape.controlPoints,
    shape.style,
    {
      id: shape.id,
      positions: () => ctx.positionsToCartesian(shape.controlPoints),
    },
  );
}
