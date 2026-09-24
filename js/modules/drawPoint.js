/**
 * 画点模块（js/modules/drawPoint.js）
 * 单击放置一个点；鼠标移动时显示预览点（半透明小点）跟随。
 * 通过 ctx（Draw 实例）调用公共工具方法，与 drawLine 模块结构一致。
 *
 * @param {object} ctx - Draw 实例（this）
 * @param {object} options - 画点参数
 * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
 * @param {object} [options.style] - 样式（lineWidth / color / pointSize）
 */
export default function drawPoint(ctx, { id, style = {} }) {
  const shape = ctx._createDrawingShape("point", { id, style });

  // 预览点：跟随鼠标（小号、无描边），初始位置在原点并隐藏
  shape.previewEntity = ctx.createPointEntity([0, 0], {
    size: Math.max(shape.style.pointSize - 4, 4),
    color: shape.style.color,
    outline: false,
  });
  shape.previewEntity.show = false;

  ctx.interactionHandler = ctx._createInteractionHandler();
  // 监听鼠标移动：更新预览点位置 + 显示坐标标签
  ctx.interactionHandler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.endPosition);
    if (!lonlat) {
      // 未命中地面：隐藏预览点
      shape.previewEntity.show = false;
      ctx._hideTooltip();
      return;
    }
    shape.previewEntity.show = true;
    shape.previewEntity.position.setValue(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
    );
    ctx._showTooltip(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      `左键放置点\n经度：${lonlat[0]}°\n纬度：${lonlat[1]}°`,
    );
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // 监听左键点击：放置点，完成绘制
  ctx.interactionHandler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.position);
    if (!lonlat || !ctx._canAddPoint(shape, lonlat)) return;

    // 移除预览点
    ctx._ownedEntities.remove(shape.previewEntity);
    shape.previewEntity = null;

    shape.controlPoints.push(lonlat);
    createPointEntity(ctx, shape);
    ctx.emit("drawAddPoint", ctx._buildGraphicResult(shape));
    if (ctx.drawingShape !== shape) return;
    ctx.completeShape(shape);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  ctx._emitDrawStart(shape);
}

// 正式点的创建入口，同时供静默回显使用
export function createPointEntity(ctx, shape) {
  shape.mainEntity = ctx.createPointEntity(shape.controlPoints[0], {
    size: shape.style.pointSize,
    color: shape.style.color,
    outline: false,
    id: shape.id,
  });
  shape.controlPointEntities = [shape.mainEntity];
}
