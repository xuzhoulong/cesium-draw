/**
 * 画圆模块（js/modules/drawCircle.js）
 * 两点确定圆：左键点击第一点定圆心 → 鼠标移动实时预览 → 左键点击第二点定半径完成。
 * 通过 ctx（Draw 实例）调用公共工具方法，与 drawRect 等模块结构一致。
 *
 * 避坑说明（与既有模块一致）：
 * - 绘制前先 ctx.stopEditing() 清理遗留 handler
 * - 实体属性全部用 CallbackProperty（基于 points + tempPoint），绘制预览 / 完成固定 / 编辑拖拽全程自动更新
 * - id 冲突时先移除旧实体再创建
 *
 * @param {object} ctx - Draw 实例（this）
 * @param {object} options - 画圆参数
 * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
 * @param {object} [options.style] - 样式（lineWidth / color / pointSize / clampToGround）
 * @param {Function} [options.success] - 绘制完成回调，返回 { id, positions, type }
 */
export default function drawCircle(ctx, { id, style = {}, success }) {
  // 避坑：开始新绘制前，退出可能存在的编辑状态并销毁遗留 handler
  ctx.stopEditing();

  const shape = {
    type: "circle",
    id, // 用户自定义实体 id（可选）
    points: [], // [圆心, 半径点]
    tempPoint: null, // 跟随鼠标的点（预览半径）
    mainEntity: null, // 圆实体（EllipseGraphics）
    pointsEntity: [], // 圆心 / 半径点实体（编辑拖拽用）
    success, // 完成回调
    style: {
      lineWidth: style.lineWidth ?? ctx.config.lineWidth,
      color: style.color ?? ctx.config.color,
      pointSize: style.pointSize ?? ctx.config.pointSize,
      clampToGround: style.clampToGround ?? ctx.config.clampToGround,
    },
  };
  ctx.activeShape = shape;

  // 避坑：传了 id 且已存在时，先移除旧实体（含 shapes 数据），覆盖创建
  if (shape.id && ctx._entities.getById(shape.id)) {
    console.warn(`实体 id "${shape.id}" 已存在，旧实体将被移除`);
    const oldShape = ctx.shapes.find((s) => s.mainEntity.id === shape.id);
    if (oldShape) {
      ctx.removeShape(oldShape);
    } else {
      ctx._entities.removeById(shape.id);
    }
  }

  createCircleGeometry(ctx, shape);

  // 加点：圆心 / 半径点实体（画线样式：小号、无白边）
  const addPoint = (lonlat) => {
    const entity = ctx.createPointEntity(lonlat, {
      size: Math.max(shape.style.pointSize - 4, 4),
      color: shape.style.color,
      outline: false,
      clampToGround: shape.style.clampToGround,
    });
    shape.pointsEntity.push(entity);
    return entity;
  };

  // 完成绘制
  const finish = () => {
    if (shape.points.length < 2) {
      // 半径未定，整个圆作废
      ctx._entities.remove(shape.mainEntity);
      shape.pointsEntity.forEach((item) => {
        ctx._entities.remove(item);
      });
      console.warn("圆需要圆心和半径两个点");
      ctx.activeShape = null;
      ctx.destroy();
      return;
    }
    shape.tempPoint = null; // 固定最终半径（CallbackProperty 自动落到最终值）
    ctx.completeShape(shape);
  };
  // 供 drawTool.stopDraw() 调用（预留，停止绘制直接清理，不触发完成）
  shape.finish = finish;

  ctx.handler = new Cesium.ScreenSpaceEventHandler(ctx.viewer.scene.canvas);
  // 监听鼠标移动：更新预览 + 显示坐标标签
  ctx.handler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.endPosition);
    if (!lonlat) {
      ctx.removeLabel();
      return; // 如果没有点击到地面，返回
    }
    ctx.addLabel(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      `左键点击圆心和半径点，右键撤销\n经度：${lonlat[0]}°\n纬度：${lonlat[1]}°`,
    );
    if (shape.points.length > 0) {
      shape.tempPoint = lonlat; // 预览半径
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // 监听左键点击：第一点圆心，第二点半径完成
  ctx.handler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.position);
    if (!lonlat) return; // 如果没有点击到地面，返回
    if (shape.points.length > 0) {
      const last = shape.points[shape.points.length - 1];
      if (last[0] === lonlat[0] && last[1] === lonlat[1]) return;
    }
    shape.points.push(lonlat);
    addPoint(lonlat);
    ctx.emit("drawAddPoint", ctx._shapeResult(shape));
    if (ctx.activeShape !== shape) return;
    if (shape.points.length >= 2) {
      finish(); // 半径点确定，完成
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 监听右键点击：撤销最后一个点（圆心 → 半径点 → 无）
  ctx.handler.setInputAction((e) => {
    if (shape.points.length === 0) return; // 没有点可撤销
    ctx._entities.remove(shape.pointsEntity.pop());
    shape.points.pop();
    if (shape.points.length > 0) {
      // 回到圆心状态，预览基于当前鼠标位置重绘
      const lonlat = ctx.pickLonLat(e.position);
      if (lonlat) {
        shape.tempPoint = lonlat;
      }
    } else {
      shape.tempPoint = null; // 圆心也撤销了，圆消失
    }
    ctx.emit("drawRemovePoint", ctx._shapeResult(shape));
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  ctx._emitDrawStart(shape);
}

// 交互与回显共用控制点算法，不注册鼠标事件
export function createCircleGeometry(ctx, shape) {
  const center = () => shape.points[0] || [0, 0];
  const radiusPoint = () => shape.points[1] || shape.tempPoint || center();
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
