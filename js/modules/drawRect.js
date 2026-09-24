/**
 * 画矩形模块（js/modules/drawRect.js）
 * 两个对角点确定矩形：左键点击第一点 → 鼠标移动实时预览 → 左键点击第二点完成。
 * 通过 ctx（Draw 实例）调用公共工具方法，与 drawLine / drawPoint 模块结构一致。
 *
 * 避坑说明（与既有模块一致）：
 * - 交互切换和会话取消由核心类统一管理
 * - 预览实体 hierarchy 用自定义回调（基于临时鼠标点），不误用 points 数组
 * - 始终保存两个对角控制点，渲染和导出时推导四个角点
 *
 * @param {object} ctx - Draw 实例（this）
 * @param {object} options - 画矩形参数
 * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
 * @param {object} [options.style] - 样式（lineWidth / color / pointSize / clampToGround）
 */
export default function drawRect(ctx, { id, style = {} }) {
  const shape = ctx._createDrawingShape("rect", { id, style });

  // 由两个对角点计算 4 个角（顺时针）
  const toCorners = getRectangleCorners;

  // 避坑：预览矩形 hierarchy 用自定义回调，根据当前对角点实时计算，不误用 points 数组
  shape.previewEntity = ctx.createPolygonEntity([], shape.style, {
    positions: () => {
      if (shape.controlPoints.length === 0) return [];
      return toCorners(
        shape.controlPoints[0],
        shape.previewPosition || shape.controlPoints[0],
      );
    },
  });
  shape.previewEntity.show = false;

  ctx.interactionHandler = ctx._createInteractionHandler();
  // 监听鼠标移动：更新预览矩形 + 显示坐标标签
  ctx.interactionHandler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.endPosition);
    if (!lonlat) {
      ctx._hideTooltip();
      return;
    }
    ctx._showTooltip(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      `左键点击确定对角点，右键撤销\n经度：${lonlat[0]}°\n纬度：${lonlat[1]}°`,
    );
    // 已有第一点时，跟随鼠标更新预览矩形
    if (shape.controlPoints.length > 0) {
      shape.previewPosition = lonlat;
      shape.previewEntity.show = true;
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // 监听左键点击：第一点定起点，第二点定对角完成
  ctx.interactionHandler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.position);
    if (!lonlat || !ctx._canAddPoint(shape, lonlat)) return;
    if (shape.controlPoints.length > 0) {
      const last = shape.controlPoints[shape.controlPoints.length - 1];
      if (last[0] === lonlat[0] && last[1] === lonlat[1]) return;
    }
    shape.controlPoints.push(lonlat);
    if (shape.controlPoints.length < 2) {
      // 第一点：显示预览矩形（跟随鼠标）
      shape.previewEntity.show = true;
      ctx.emit("drawAddPoint", ctx._buildGraphicResult(shape));
      return;
    }
    ctx.emit("drawAddPoint", ctx._buildGraphicResult(shape));
    if (ctx.drawingShape !== shape) return;
    // 第二点：完成绘制
    finishRect();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 监听右键点击：撤销最后一个对角点，预览重绘
  ctx.interactionHandler.setInputAction((e) => {
    if (shape.controlPoints.length === 0) return; // 没有点可撤销
    shape.controlPoints.pop();
    if (shape.controlPoints.length === 0) {
      // 没有点了，预览矩形消失
      shape.previewEntity.show = false;
      shape.previewPosition = null;
    } else {
      // 回到第一点状态，预览矩形基于当前鼠标位置重绘
      const lonlat = ctx.pickLonLat(e.position);
      if (lonlat) {
        shape.previewPosition = lonlat;
        shape.previewEntity.show = true;
      }
    }
    ctx.emit("drawRemovePoint", ctx._buildGraphicResult(shape));
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

  // 完成绘制
  function finishRect() {
    if (shape.controlPoints.length < 2) return;
    // 移除预览矩形
    ctx._ownedEntities.remove(shape.previewEntity);
    shape.previewEntity = null;
    createRectangleEntity(ctx, shape);
    ctx.completeShape(shape);
  }
  ctx._emitDrawStart(shape);
}

export function getRectangleCorners(a, b) {
  return [
    [a[0], a[1]],
    [b[0], a[1]],
    [b[0], b[1]],
    [a[0], b[1]],
  ];
}

// 交互与回显共用四角生成及对角点联动
export function createRectangleEntity(ctx, shape) {
  shape.mainEntity = ctx.createPolygonEntity(shape.controlPoints, shape.style, {
    id: shape.id,
    positions: () => getRectangleCorners(...shape.controlPoints),
  });
  shape.updatePoint = (index, point) => {
    const [a, b] = shape.controlPoints;
    const x = index === 0 || index === 3 ? a : b;
    const y = index === 0 || index === 1 ? a : b;
    x[0] = point[0];
    y[1] = point[1];
  };
}
