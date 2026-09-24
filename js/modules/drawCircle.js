/**
 * 画圆模块（js/modules/drawCircle.js）
 * 两点确定圆：左键点击第一点定圆心 → 鼠标移动实时预览 → 左键点击第二点定半径完成。
 * 通过 ctx（Draw 实例）调用公共工具方法，与 drawRect 等模块结构一致。
 *
 * 避坑说明（与既有模块一致）：
 * - 交互切换和会话取消由核心类统一管理
 * - 实体属性全部用 CallbackProperty（基于 points + previewPosition），绘制预览 / 完成固定 / 编辑拖拽全程自动更新
 * - id 冲突时先移除旧实体再创建
 *
 * @param {object} ctx - Draw 实例（this）
 * @param {object} options - 画圆参数
 * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
 * @param {object} [options.style] - 样式（lineWidth / color / pointSize / clampToGround）
 */
export default function drawCircle(ctx, { id, style = {} }) {
  const shape = ctx._createDrawingShape("circle", { id, style });

  createCircleEntity(ctx, shape);

  // 加点：圆心 / 半径点实体（画线样式：小号、无白边）
  const addPoint = (lonlat) => {
    const entity = ctx._createControlPoint(shape, lonlat);
    shape.controlPointEntities.push(entity);
    return entity;
  };

  // 完成绘制
  const finish = () => {
    if (shape.controlPoints.length < 2) {
      // 半径未定，整个圆作废
      ctx._ownedEntities.remove(shape.mainEntity);
      shape.controlPointEntities.forEach((item) => {
        ctx._ownedEntities.remove(item);
      });
      console.warn("圆需要圆心和半径两个点");
      ctx.stopDraw();
      return;
    }
    shape.previewPosition = null; // 固定最终半径（CallbackProperty 自动落到最终值）
    ctx.completeShape(shape);
  };

  ctx.interactionHandler = ctx._createInteractionHandler();
  // 监听鼠标移动：更新预览 + 显示坐标标签
  ctx.interactionHandler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.endPosition);
    if (!lonlat) {
      ctx._hideTooltip();
      return; // 如果没有点击到地面，返回
    }
    ctx._showTooltip(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      `左键点击圆心和半径点，右键撤销\n经度：${lonlat[0]}°\n纬度：${lonlat[1]}°`,
    );
    if (shape.controlPoints.length > 0) {
      shape.previewPosition = lonlat; // 预览半径
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // 监听左键点击：第一点圆心，第二点半径完成
  ctx.interactionHandler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.position);
    if (!lonlat || !ctx._canAddPoint(shape, lonlat)) return;
    if (shape.controlPoints.length > 0) {
      const last = shape.controlPoints[shape.controlPoints.length - 1];
      if (last[0] === lonlat[0] && last[1] === lonlat[1]) return;
    }
    shape.controlPoints.push(lonlat);
    addPoint(lonlat);
    ctx.emit("drawAddPoint", ctx._buildGraphicResult(shape));
    if (ctx.drawingShape !== shape) return;
    if (shape.controlPoints.length >= 2) {
      finish(); // 半径点确定，完成
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 监听右键点击：撤销最后一个点（圆心 → 半径点 → 无）
  ctx.interactionHandler.setInputAction((e) => {
    if (shape.controlPoints.length === 0) return; // 没有点可撤销
    ctx._ownedEntities.remove(shape.controlPointEntities.pop());
    shape.controlPoints.pop();
    if (shape.controlPoints.length > 0) {
      // 回到圆心状态，预览基于当前鼠标位置重绘
      const lonlat = ctx.pickLonLat(e.position);
      if (lonlat) {
        shape.previewPosition = lonlat;
      }
    } else {
      shape.previewPosition = null; // 圆心也撤销了，圆消失
    }
    ctx.emit("drawRemovePoint", ctx._buildGraphicResult(shape));
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  ctx._emitDrawStart(shape);
}

// 交互与回显共用控制点算法，不注册鼠标事件
export function createCircleEntity(ctx, shape) {
  const center = () => shape.controlPoints[0] || [0, 0];
  const radiusPoint = () =>
    shape.controlPoints[1] || shape.previewPosition || center();
  const radius = () =>
    Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(...center()),
      Cesium.Cartesian3.fromDegrees(...radiusPoint()),
    );
  shape.mainEntity = ctx.createEllipseEntity([0, 0], shape.style, {
    id: shape.id,
    position: () => Cesium.Cartesian3.fromDegrees(...center()),
    semiMajorAxis: radius,
    semiMinorAxis: radius,
    rotation: () => 0,
  });
}
